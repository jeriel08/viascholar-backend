import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { CoordinatorBaselineService } from './coordinator-baseline.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { EventsGateway } from '../../events/events.gateway.js';
import { AppCacheService } from '../../common/cache/app-cache.service.js';
import { BatchUpdateSubjectsDto } from '../dto/batch-update-subjects.dto.js';

// Asymmetric matchers are untyped; cast once so nested properties satisfy the linter.
const anyArg = (ctor: unknown) => expect.any(ctor) as unknown;
const objectMatching = (shape: Record<string, unknown>) =>
  expect.objectContaining(shape) as Record<string, unknown>;

const createPrismaMock = () => ({
  scholarProfile: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  employee: {
    findUnique: vi.fn(),
  },
  scholarProspectus: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  prospectusSubject: {
    update: vi.fn(),
    create: vi.fn(),
    deleteMany: vi.fn(),
  },
  scholarDocument: {
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  user: {
    findUnique: vi.fn(),
  },
  academicChangeRequest: {
    findFirst: vi.fn(),
  },
});

const createAuditMock = () => ({ log: vi.fn() });
const createEventsMock = () => ({
  emitToStaff: vi.fn(),
  emitToUser: vi.fn(),
});
const createCacheMock = () => ({
  wrap: vi.fn(),
  del: vi.fn(),
  delPattern: vi.fn(),
});

const makeSubject = (overrides: Record<string, unknown> = {}) => ({
  subject_id: 1,
  subject_code: 'CCE101',
  descriptive_title: 'Introduction to Computing',
  units: 3,
  year_level: 1,
  semester: '1st Semester',
  status: 'UNTAKEN',
  grade: null,
  historical_document_id: null,
  ...overrides,
});

const makeReviewScholar = (overrides: Record<string, unknown> = {}) => ({
  profile_id: 11,
  first_name: 'Juan',
  last_name: 'Dela Cruz',
  student_number: '2024-001',
  course_of_study: 'BSIT',
  school_name: null,
  current_year_level: 3,
  academic_baseline_status: 'PENDING_COORDINATOR_REVIEW',
  user: {
    email: 'juan@example.com',
    created_at: new Date('2025-06-01T08:00:00.000Z'),
  },
  school_grading_system: {
    school_id: 1,
    school_name: 'University of Mindanao',
  },
  prospectus: {
    prospectus_id: 60,
    document_id: 50,
    is_frozen: false,
    document: { document_id: 50, document_type: 'PROSPECTUS' },
    frozen_by_employee: null,
    subjects: [
      makeSubject({ subject_id: 1, units: 3, status: 'PASSED' }),
      makeSubject({ subject_id: 2, units: 4, status: 'CREDITED' }),
      makeSubject({ subject_id: 3, units: 3, status: 'UNTAKEN' }),
      makeSubject({ subject_id: 4, units: 2, status: 'FAILED' }),
    ],
  },
  documents: [{ document_id: 50, document_type: 'PROSPECTUS' }],
  ...overrides,
});

const makeFreezeProspectus = (overrides: Record<string, unknown> = {}) => ({
  prospectus_id: 60,
  scholar_profile_id: 11,
  document_id: 50,
  is_frozen: false,
  scholar_profile: {
    profile_id: 11,
    user_id: 7,
    first_name: 'Juan',
    last_name: 'Dela Cruz',
    user: { user_id: 7 },
  },
  subjects: [
    makeSubject({ subject_id: 1, historical_document_id: 70 }),
    makeSubject({ subject_id: 2, historical_document_id: null }),
  ],
  ...overrides,
});

const makeSubjectsDto = () =>
  ({
    course_name: 'BSIT',
    course_code: 'BSIT',
    curriculum_year: '2024',
    subjects: [
      {
        subject_id: 5,
        subject_code: ' cce 102 ',
        descriptive_title: ' Data Structures ',
        units: 3,
        year_level: 2,
        semester: '1st Semester',
        status: 'CREDITED',
        grade: 1.25,
        prerequisites: ['CCE 101'],
        credited_term: '1st Year - 1st Semester',
        remarks: 'Verified',
      },
      {
        subject_code: ' ge 2 ',
        descriptive_title: ' Art Appreciation ',
        units: 3,
        year_level: 1,
        semester: '2nd Semester',
      },
    ],
  }) as BatchUpdateSubjectsDto;

describe('CoordinatorBaselineService', () => {
  let service: CoordinatorBaselineService;
  let prisma: ReturnType<typeof createPrismaMock>;
  let audit: ReturnType<typeof createAuditMock>;
  let events: ReturnType<typeof createEventsMock>;
  let cache: ReturnType<typeof createCacheMock>;

  beforeEach(async () => {
    prisma = createPrismaMock();
    audit = createAuditMock();
    events = createEventsMock();
    cache = createCacheMock();

    cache.wrap.mockImplementation(
      async (_key: string, factory: () => Promise<unknown>) => factory(),
    );

    prisma.scholarProfile.findMany.mockResolvedValue([{ profile_id: 11 }]);
    prisma.scholarProfile.findUnique.mockResolvedValue(makeReviewScholar());
    prisma.scholarProfile.update.mockResolvedValue({ profile_id: 11 });
    prisma.employee.findUnique.mockResolvedValue({
      employee_id: 2,
      first_name: 'Maria',
      last_name: 'Santos',
      title: 'Coordinator',
    });
    prisma.scholarProspectus.findUnique.mockResolvedValue(
      makeFreezeProspectus(),
    );
    prisma.scholarProspectus.update.mockResolvedValue({
      prospectus_id: 60,
      is_frozen: true,
      subjects: [],
    });
    prisma.prospectusSubject.update.mockResolvedValue({ subject_id: 5 });
    prisma.prospectusSubject.create.mockResolvedValue({ subject_id: 6 });
    prisma.scholarDocument.update.mockResolvedValue({ document_id: 50 });
    prisma.scholarDocument.updateMany.mockResolvedValue({ count: 1 });
    prisma.user.findUnique.mockResolvedValue({ role: 'COORDINATOR' });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CoordinatorBaselineService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: EventsGateway, useValue: events },
        { provide: AppCacheService, useValue: cache },
      ],
    }).compile();

    service = module.get<CoordinatorBaselineService>(
      CoordinatorBaselineService,
    );
  });

  it('is created by the Nest testing module', () => {
    expect(service).toBeDefined();
  });

  describe('getCoordinatorPendingBaselines', () => {
    it('queries scholars in review-related baseline states', async () => {
      const expected = [{ profile_id: 11 }];
      prisma.scholarProfile.findMany.mockResolvedValue(expected);

      const result = await service.getCoordinatorPendingBaselines();

      expect(prisma.scholarProfile.findMany).toHaveBeenCalledWith(
        objectMatching({
          where: {
            academic_baseline_status: {
              in: [
                'PENDING_COORDINATOR_REVIEW',
                'PENDING_SHIFT_PROSPECTUS',
                'PENDING_PROSPECTUS',
                'PENDING_HISTORICAL_CCG',
                'BASELINE_FROZEN',
              ],
            },
          },
          orderBy: { profile_id: 'desc' },
        }),
      );
      expect(result).toBe(expected);
    });
  });

  describe('getCoordinatorBaselineReview', () => {
    it('caches the review bundle for one hour and honors refresh', async () => {
      await service.getCoordinatorBaselineReview(11, true);

      expect(cache.wrap).toHaveBeenCalledWith(
        'baseline:review:11',
        anyArg(Function),
        60 * 60 * 1000,
        true,
      );
      expect(prisma.scholarProfile.findUnique).toHaveBeenCalledWith(
        objectMatching({ where: { profile_id: 11 } }),
      );
    });

    it('maps the scholar identity and curriculum metrics', async () => {
      const result = await service.getCoordinatorBaselineReview(11);

      expect(result.scholar_profile).toEqual({
        profile_id: 11,
        student_name: 'Juan Dela Cruz',
        student_number: '2024-001',
        course_of_study: 'BSIT',
        school_name: null,
        current_year_level: 3,
        email: 'juan@example.com',
        academic_baseline_status: 'PENDING_COORDINATOR_REVIEW',
      });
      expect(result.school_grading_system).toEqual({
        school_id: 1,
        school_name: 'University of Mindanao',
      });
      expect(result.documents).toHaveLength(1);
      expect(result.metrics).toEqual({
        total_subjects: 4,
        total_units: 12,
        credited_units: 7,
        remaining_units: 5,
        is_frozen: false,
      });
    });

    it('returns empty metrics when the scholar has no prospectus', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue(
        makeReviewScholar({ prospectus: null }),
      );

      const result = await service.getCoordinatorBaselineReview(11);

      expect(result.prospectus).toBeNull();
      expect(result.metrics).toEqual({
        total_subjects: 0,
        total_units: 0,
        credited_units: 0,
        remaining_units: 0,
        is_frozen: false,
      });
    });

    it('throws NotFoundException when the scholar profile is missing', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue(null);

      await expect(service.getCoordinatorBaselineReview(99)).rejects.toThrow(
        new NotFoundException('Scholar profile ID 99 not found.'),
      );
    });
  });

  describe('coordinatorUpdateSubjects', () => {
    it('throws NotFoundException when the employee profile is missing', async () => {
      prisma.employee.findUnique.mockResolvedValue(null);

      await expect(
        service.coordinatorUpdateSubjects(2, 60, makeSubjectsDto()),
      ).rejects.toThrow('Employee profile not found.');
    });

    it('throws NotFoundException when the prospectus is missing', async () => {
      prisma.scholarProspectus.findUnique.mockResolvedValue(null);

      await expect(
        service.coordinatorUpdateSubjects(2, 60, makeSubjectsDto()),
      ).rejects.toThrow('Prospectus ID 60 not found.');
    });

    it('updates the header and upserts existing and new subjects', async () => {
      const refreshed = { prospectus_id: 60, subjects: [] };
      prisma.scholarProspectus.findUnique
        .mockResolvedValueOnce({
          prospectus_id: 60,
          scholar_profile_id: 11,
          scholar_profile: { profile_id: 11, user_id: 7 },
        })
        .mockResolvedValueOnce(refreshed);

      const result = await service.coordinatorUpdateSubjects(
        2,
        60,
        makeSubjectsDto(),
      );

      expect(prisma.scholarProspectus.update).toHaveBeenCalledWith({
        where: { prospectus_id: 60 },
        data: {
          course_name: 'BSIT',
          course_code: 'BSIT',
          curriculum_year: '2024',
        },
      });
      expect(prisma.prospectusSubject.update).toHaveBeenCalledWith({
        where: { subject_id: 5 },
        data: {
          subject_code: 'CCE 102',
          descriptive_title: 'Data Structures',
          units: 3,
          year_level: 2,
          semester: '1st Semester',
          prerequisites: ['CCE 101'],
          status: 'CREDITED',
          grade: 1.25,
          credited_term: '1st Year - 1st Semester',
          remarks: 'Verified',
        },
      });
      expect(prisma.prospectusSubject.create).toHaveBeenCalledWith({
        data: {
          prospectus_id: 60,
          subject_code: 'GE 2',
          descriptive_title: 'Art Appreciation',
          units: 3,
          year_level: 1,
          semester: '2nd Semester',
          prerequisites: [],
          status: 'UNTAKEN',
          grade: undefined,
          credited_term: undefined,
          remarks: undefined,
        },
      });
      expect(audit.log).toHaveBeenCalledWith(
        2,
        'COORDINATOR_UPDATED_BASELINE_SUBJECTS',
        'Coordinator updated 2 subjects on prospectus ID 60.',
      );
      expect(cache.del).toHaveBeenCalledWith('baseline:scholar:7');
      expect(cache.del).toHaveBeenCalledWith('dashboard:scholar:7');
      expect(cache.del).toHaveBeenCalledWith('baseline:review:11');
      expect(result).toEqual({
        message: 'Prospectus subjects updated by coordinator.',
        prospectus: refreshed,
      });
    });

    it('skips user-specific cache invalidation without a linked user', async () => {
      prisma.scholarProspectus.findUnique
        .mockResolvedValueOnce({
          prospectus_id: 60,
          scholar_profile_id: 11,
          scholar_profile: { profile_id: 11, user_id: null },
        })
        .mockResolvedValueOnce({ prospectus_id: 60, subjects: [] });

      await service.coordinatorUpdateSubjects(2, 60, makeSubjectsDto());

      expect(cache.del).not.toHaveBeenCalledWith('baseline:scholar:null');
      expect(cache.del).toHaveBeenCalledWith('baseline:review:11');
    });
  });

  describe('freezeBaseline', () => {
    it('throws NotFoundException when the employee profile is missing', async () => {
      prisma.employee.findUnique.mockResolvedValue(null);

      await expect(service.freezeBaseline(2, 60, {})).rejects.toThrow(
        'Employee profile not found.',
      );
    });

    it('throws NotFoundException when the prospectus is missing', async () => {
      prisma.scholarProspectus.findUnique.mockResolvedValue(null);

      await expect(service.freezeBaseline(2, 60, {})).rejects.toThrow(
        'Prospectus ID 60 not found.',
      );
    });

    it('rejects freezing a baseline that is already frozen', async () => {
      prisma.scholarProspectus.findUnique.mockResolvedValue(
        makeFreezeProspectus({ is_frozen: true }),
      );

      await expect(service.freezeBaseline(2, 60, {})).rejects.toThrow(
        new BadRequestException('This academic baseline is already frozen.'),
      );
    });

    it('locks the prospectus, verifies documents, and notifies the scholar', async () => {
      const result = await service.freezeBaseline(2, 60, {
        remarks: 'Verified',
      });

      expect(prisma.scholarProspectus.update).toHaveBeenCalledWith(
        objectMatching({
          where: { prospectus_id: 60 },
          data: {
            is_frozen: true,
            frozen_at: anyArg(Date),
            frozen_by_employee_id: 2,
            status: 'FROZEN',
          },
        }),
      );
      expect(prisma.scholarDocument.update).toHaveBeenCalledWith({
        where: { document_id: 50 },
        data: {
          status: 'VERIFIED',
          verified_at: anyArg(Date),
          reviewed_by_employee_id: 2,
        },
      });
      expect(prisma.scholarDocument.updateMany).toHaveBeenCalledWith({
        where: { document_id: { in: [70] } },
        data: {
          status: 'VERIFIED',
          verified_at: anyArg(Date),
          reviewed_by_employee_id: 2,
        },
      });
      expect(prisma.scholarProfile.update).toHaveBeenCalledWith({
        where: { profile_id: 11 },
        data: { academic_baseline_status: 'BASELINE_FROZEN' },
      });
      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { user_id: 2 },
        select: { role: true },
      });

      expect(audit.log).toHaveBeenCalledWith(
        2,
        'BASELINE_FROZEN',
        expect.stringContaining(
          'Coordinator Maria Santos (Coordinator) froze academic baseline for scholar Juan Dela Cruz (Prospectus ID: 60). Remarks: Verified',
        ),
      );

      const payload = {
        prospectusId: 60,
        scholarProfileId: 11,
        studentName: 'Juan Dela Cruz',
        isFrozen: true,
        frozenAt: anyArg(String),
        frozenBy: 'Maria Santos',
        frozenByRole: 'COORDINATOR',
        frozenByTitle: 'Coordinator',
        academic_baseline_status: 'BASELINE_FROZEN',
      };
      expect(events.emitToStaff).toHaveBeenCalledWith(
        'baseline:frozen',
        payload,
      );
      expect(events.emitToUser).toHaveBeenCalledWith(
        7,
        'baseline:frozen',
        payload,
      );

      expect(cache.del).toHaveBeenCalledWith('baseline:scholar:7');
      expect(cache.del).toHaveBeenCalledWith('dashboard:scholar:7');
      expect(cache.del).toHaveBeenCalledWith('baseline:review:11');
      expect(cache.delPattern).toHaveBeenCalledWith('dashboard:coordinator:');
      expect(result).toEqual({
        message:
          'Academic baseline for Juan Dela Cruz has been frozen and locked successfully.',
        prospectus: { prospectus_id: 60, is_frozen: true, subjects: [] },
        academic_baseline_status: 'BASELINE_FROZEN',
      });
    });

    it('handles missing documents, title, and linked user gracefully', async () => {
      prisma.employee.findUnique.mockResolvedValue({
        employee_id: 2,
        first_name: 'Maria',
        last_name: 'Santos',
        title: null,
      });
      prisma.scholarProspectus.findUnique.mockResolvedValue(
        makeFreezeProspectus({
          document_id: null,
          scholar_profile: {
            profile_id: 11,
            user_id: null,
            first_name: 'Juan',
            last_name: 'Dela Cruz',
            user: null,
          },
          subjects: [makeSubject({ historical_document_id: null })],
        }),
      );
      prisma.user.findUnique.mockResolvedValue(null);

      await service.freezeBaseline(2, 60, {});

      expect(prisma.scholarDocument.update).not.toHaveBeenCalled();
      expect(prisma.scholarDocument.updateMany).not.toHaveBeenCalled();
      expect(audit.log).toHaveBeenCalledWith(
        2,
        'BASELINE_FROZEN',
        expect.stringContaining(
          'Staff Maria Santos (Staff) froze academic baseline for scholar Juan Dela Cruz (Prospectus ID: 60). Remarks: None',
        ),
      );
      expect(events.emitToStaff).toHaveBeenCalledWith(
        'baseline:frozen',
        objectMatching({
          frozenByRole: 'COORDINATOR',
          frozenByTitle: null,
          academic_baseline_status: 'BASELINE_FROZEN',
        }),
      );
      expect(events.emitToUser).not.toHaveBeenCalled();
      expect(cache.del).not.toHaveBeenCalledWith('baseline:scholar:null');
      expect(cache.del).toHaveBeenCalledWith('baseline:review:11');
    });
  });

  describe('unfreezeBaseline', () => {
    it('throws NotFoundException when the employee profile is missing', async () => {
      prisma.employee.findUnique.mockResolvedValue(null);

      await expect(service.unfreezeBaseline(2, 60)).rejects.toThrow(
        'Employee profile not found.',
      );
    });

    it('throws NotFoundException when the prospectus is missing', async () => {
      prisma.scholarProspectus.findUnique.mockResolvedValue(null);

      await expect(service.unfreezeBaseline(2, 60)).rejects.toThrow(
        'Prospectus ID 60 not found.',
      );
    });

    it('unlocks the baseline and returns it to coordinator review', async () => {
      prisma.scholarProspectus.findUnique.mockResolvedValue({
        prospectus_id: 60,
        scholar_profile_id: 11,
        is_frozen: true,
        scholar_profile: { profile_id: 11, user_id: 7 },
      });
      prisma.scholarProspectus.update.mockResolvedValue({
        prospectus_id: 60,
        is_frozen: false,
        status: 'PENDING_REVIEW',
      });

      const result = await service.unfreezeBaseline(2, 60);

      expect(prisma.scholarProspectus.update).toHaveBeenCalledWith({
        where: { prospectus_id: 60 },
        data: {
          is_frozen: false,
          status: 'PENDING_REVIEW',
        },
      });
      expect(prisma.scholarProfile.update).toHaveBeenCalledWith({
        where: { profile_id: 11 },
        data: { academic_baseline_status: 'PENDING_COORDINATOR_REVIEW' },
      });
      expect(audit.log).toHaveBeenCalledWith(
        2,
        'BASELINE_UNFROZEN',
        'Coordinator Maria Santos unlocked academic baseline for prospectus ID 60.',
      );
      expect(events.emitToStaff).toHaveBeenCalledWith('baseline:unfrozen', {
        prospectusId: 60,
        scholarProfileId: 11,
      });
      expect(cache.del).toHaveBeenCalledWith('baseline:scholar:7');
      expect(cache.del).toHaveBeenCalledWith('dashboard:scholar:7');
      expect(cache.del).toHaveBeenCalledWith('baseline:review:11');
      expect(cache.delPattern).toHaveBeenCalledWith('dashboard:coordinator:');
      expect(result).toEqual({
        message: 'Academic baseline unlocked for edits.',
        prospectus: {
          prospectus_id: 60,
          is_frozen: false,
          status: 'PENDING_REVIEW',
        },
        academic_baseline_status: 'PENDING_COORDINATOR_REVIEW',
      });
    });

    it('skips user-specific cache invalidation without a linked user', async () => {
      prisma.scholarProspectus.findUnique.mockResolvedValue({
        prospectus_id: 60,
        scholar_profile_id: 11,
        scholar_profile: { profile_id: 11, user_id: null },
      });

      await service.unfreezeBaseline(2, 60);

      expect(cache.del).not.toHaveBeenCalledWith('baseline:scholar:null');
      expect(cache.del).toHaveBeenCalledWith('baseline:review:11');
    });
  });

  describe('shift waiting guards', () => {
    it('hides stale old prospectus in getCoordinatorBaselineReview while awaiting new shift prospectus upload', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue(
        makeReviewScholar({
          academic_baseline_status: 'PENDING_SHIFT_PROSPECTUS',
          prospectus: {
            prospectus_id: 60,
            document_id: 50,
            is_frozen: false,
            document: {
              document_id: 50,
              document_type: 'PROSPECTUS',
              uploaded_at: new Date('2026-01-01T08:00:00.000Z'),
            },
            frozen_by_employee: null,
            subjects: [makeSubject({ subject_id: 1, units: 3 })],
          },
        }),
      );
      prisma.academicChangeRequest.findFirst.mockResolvedValue({
        request_id: 9,
        status: 'APPROVED',
        reviewed_at: new Date('2026-02-01T08:00:00.000Z'),
      });

      const result = await service.getCoordinatorBaselineReview(11, true);

      expect(result.awaiting_new_prospectus_upload).toBe(true);
      expect(result.prospectus).toBeNull();
      expect(result.documents).toEqual([]);
      expect(result.metrics.total_subjects).toBe(0);
    });

    it('blocks freezeBaseline while scholar is in PENDING_SHIFT_PROSPECTUS without a new upload', async () => {
      prisma.scholarProspectus.findUnique.mockResolvedValue(
        makeFreezeProspectus({
          document: { uploaded_at: new Date('2026-01-01T08:00:00.000Z') },
          scholar_profile: {
            profile_id: 11,
            user_id: 7,
            first_name: 'Juan',
            last_name: 'Dela Cruz',
            academic_baseline_status: 'PENDING_SHIFT_PROSPECTUS',
            user: { user_id: 7 },
          },
        }),
      );
      prisma.academicChangeRequest.findFirst.mockResolvedValue({
        request_id: 9,
        status: 'APPROVED',
        reviewed_at: new Date('2026-02-01T08:00:00.000Z'),
      });

      await expect(service.freezeBaseline(2, 60, {})).rejects.toThrow(
        /Cannot freeze baseline/i,
      );
      expect(prisma.scholarProspectus.update).not.toHaveBeenCalled();
    });

    it('blocks coordinatorUpdateSubjects while scholar is in PENDING_SHIFT_PROSPECTUS without a new upload', async () => {
      prisma.scholarProspectus.findUnique.mockResolvedValue({
        prospectus_id: 60,
        scholar_profile_id: 11,
        document_id: 50,
        document: { uploaded_at: new Date('2026-01-01T08:00:00.000Z') },
        scholar_profile: {
          profile_id: 11,
          user_id: 7,
          academic_baseline_status: 'PENDING_SHIFT_PROSPECTUS',
        },
      });
      prisma.academicChangeRequest.findFirst.mockResolvedValue({
        request_id: 9,
        status: 'APPROVED',
        reviewed_at: new Date('2026-02-01T08:00:00.000Z'),
      });

      await expect(
        service.coordinatorUpdateSubjects(2, 60, makeSubjectsDto()),
      ).rejects.toThrow(/Cannot modify prospectus subjects/i);
      expect(prisma.scholarProspectus.update).not.toHaveBeenCalled();
    });

    it('prunes leftover pre-shift subjects when inspecting a post-shift prospectus in getCoordinatorBaselineReview', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue(
        makeReviewScholar({
          user_id: 7,
          academic_baseline_status: 'PENDING_COORDINATOR_REVIEW',
          prospectus: {
            prospectus_id: 61,
            document_id: 51,
            is_frozen: false,
            document: {
              document_id: 51,
              document_type: 'PROSPECTUS',
              uploaded_at: new Date('2026-02-02T08:00:00.000Z'),
            },
            frozen_by_employee: null,
            subjects: [
              makeSubject({
                subject_id: 10,
                subject_code: 'OLD101',
                status: 'PASSED',
                units: 3,
                created_at: new Date('2026-01-01T08:00:00.000Z'),
              }),
              makeSubject({
                subject_id: 11,
                subject_code: 'NEW101',
                status: 'CREDITED',
                units: 4,
                created_at: new Date('2026-02-02T08:00:01.000Z'),
              }),
            ],
          },
        }),
      );
      prisma.academicChangeRequest.findFirst.mockResolvedValue({
        request_id: 9,
        status: 'APPROVED',
        reviewed_at: new Date('2026-02-01T08:00:00.000Z'),
      });

      const result = await service.getCoordinatorBaselineReview(11, true);

      expect(prisma.prospectusSubject.deleteMany).toHaveBeenCalledWith({
        where: { subject_id: { in: [10] } },
      });
      expect(result.prospectus?.subjects).toHaveLength(1);
      expect(result.prospectus?.subjects[0].subject_code).toBe('NEW101');
      expect(result.metrics.total_subjects).toBe(1);
      expect(result.metrics.total_units).toBe(4);
      expect(cache.del).toHaveBeenCalledWith('baseline:scholar:7');
    });
  });
});
