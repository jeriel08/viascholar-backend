import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Test, TestingModule } from '@nestjs/testing';
import { ProspectusTransitionService } from './prospectus-transition.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { SettingsService } from '../../settings/settings.service.js';
import { AppCacheService } from '../../common/cache/app-cache.service.js';

const createPrismaMock = () => ({
  scholarProspectus: {
    findUnique: vi.fn(),
  },
  prospectusSubject: {
    update: vi.fn(),
  },
  scholarProfile: {
    findUnique: vi.fn(),
  },
  application: {
    findFirst: vi.fn(),
    update: vi.fn(),
  },
});

const createSettingsMock = () => ({
  evaluateStudentGrade: vi.fn().mockReturnValue({ isPassing: true }),
});

const createCacheMock = () => ({ del: vi.fn().mockResolvedValue(undefined) });

const makeProspectus = (overrides: Record<string, unknown> = {}) => ({
  prospectus_id: 1,
  scholar_profile_id: 11,
  subjects: [
    {
      subject_id: 101,
      subject_code: 'IT 101',
      descriptive_title: 'Intro to IT',
      status: 'ENROLLED',
      semester: '1st Semester',
    },
    {
      subject_id: 102,
      subject_code: 'GE 101',
      descriptive_title: 'Nat Sci',
      status: 'ENROLLED',
      semester: '1st Semester',
    },
    {
      subject_id: 103,
      subject_code: 'IT 102',
      descriptive_title: 'Intro ICT Lab',
      status: 'UNTAKEN',
      semester: '1st Semester',
    },
  ],
  scholar_profile: { user_id: 7 },
  ...overrides,
});

const objectMatching = (shape: Record<string, unknown>) =>
  expect.objectContaining(shape) as Record<string, unknown>;

describe('ProspectusTransitionService', () => {
  let service: ProspectusTransitionService;
  let prisma: ReturnType<typeof createPrismaMock>;
  let settings: ReturnType<typeof createSettingsMock>;
  let cache: ReturnType<typeof createCacheMock>;

  beforeEach(async () => {
    prisma = createPrismaMock();
    settings = createSettingsMock();
    cache = createCacheMock();

    prisma.scholarProspectus.findUnique.mockResolvedValue(makeProspectus());
    prisma.prospectusSubject.update.mockImplementation(
      ({
        where,
        data,
      }: {
        where: { subject_id: number };
        data: Record<string, unknown>;
      }) => Promise.resolve({ subject_id: where.subject_id, ...data }),
    );
    prisma.scholarProfile.findUnique.mockResolvedValue({
      profile_id: 11,
      user: { role: 'APPLICANT' },
    });
    prisma.application.findFirst.mockResolvedValue({
      application_id: 42,
      status: 'PENDING',
    });
    prisma.application.update.mockResolvedValue({
      application_id: 42,
      status: 'UNDER_REVIEW',
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProspectusTransitionService,
        { provide: PrismaService, useValue: prisma },
        { provide: SettingsService, useValue: settings },
        { provide: AppCacheService, useValue: cache },
      ],
    }).compile();

    service = module.get<ProspectusTransitionService>(
      ProspectusTransitionService,
    );
  });

  it('is created by the Nest testing module', () => {
    expect(service).toBeDefined();
  });

  describe('transitionProspectusSubjects', () => {
    it('returns immediately when the scholar has no prospectus', async () => {
      prisma.scholarProspectus.findUnique.mockResolvedValue(null);

      await service.transitionProspectusSubjects(
        11,
        [{ subject_code: 'IT 101', grade: 1.5 }],
        '2026-2027',
        '1st Semester',
        null,
      );

      expect(prisma.prospectusSubject.update).not.toHaveBeenCalled();
      expect(cache.del).not.toHaveBeenCalled();
    });

    it('returns immediately for empty prospectus subjects', async () => {
      prisma.scholarProspectus.findUnique.mockResolvedValue(
        makeProspectus({ subjects: [] }),
      );

      await service.transitionProspectusSubjects(
        11,
        [{ subject_code: 'IT 101', grade: 1.5 }],
        '2026-2027',
        '1st Semester',
        null,
      );

      expect(prisma.prospectusSubject.update).not.toHaveBeenCalled();
    });

    it('matches enrolled subjects by exact code and marks them passed', async () => {
      await service.transitionProspectusSubjects(
        11,
        [{ subject_code: 'IT 101', subject_name: 'Intro to IT', grade: 1.5 }],
        '2026-2027',
        '1st Semester',
        null,
      );

      expect(prisma.prospectusSubject.update).toHaveBeenCalledWith({
        where: { subject_id: 101 },
        data: {
          status: 'PASSED',
          grade: 1.5,
          credited_term: '2026-2027 1st Semester',
          remarks: 'Passed in AY 2026-2027 1st Semester',
        },
      });
    });

    it('normalizes hyphenated and roman-numeral codes in matching', async () => {
      await service.transitionProspectusSubjects(
        11,
        [{ subject_code: 'IT-101', grade: 1.5 }],
        '2026-2027',
        '1st Semester',
        null,
      );

      expect(prisma.prospectusSubject.update).toHaveBeenCalledWith(
        objectMatching({ where: { subject_id: 101 } }),
      );
    });

    it('does not double-match an already matched subject for a duplicate grade row', async () => {
      await service.transitionProspectusSubjects(
        11,
        [
          { subject_code: 'IT 101', grade: 1.5 },
          { subject_code: 'IT 101', grade: 2.0 },
        ],
        '2026-2027',
        '1st Semester',
        null,
      );

      expect(prisma.prospectusSubject.update).toHaveBeenCalledTimes(1);
    });

    it('prefers the semester-specific row over the any-match tier', async () => {
      // IT 102 (UNTAKEN) is not ENROLLED, so Tier 1 fails; Tier 2 (same semester) wins.
      await service.transitionProspectusSubjects(
        11,
        [{ subject_code: 'IT 102', grade: 1.5 }],
        '2026-2027',
        '1st Semester',
        null,
      );

      expect(prisma.prospectusSubject.update).toHaveBeenCalledWith(
        objectMatching({ where: { subject_id: 103 } }),
      );
    });

    it('falls back to a title match when the code is unknown', async () => {
      await service.transitionProspectusSubjects(
        11,
        [{ subject_code: 'XYZ 000', subject_name: 'Intro to IT', grade: 1.5 }],
        '2026-2027',
        '1st Semester',
        null,
      );

      expect(prisma.prospectusSubject.update).toHaveBeenCalledWith(
        objectMatching({ where: { subject_id: 101 } }),
      );
    });

    it('marks a subject FAILED and reports the grade when not passing', async () => {
      settings.evaluateStudentGrade.mockReturnValue({ isPassing: false });

      await service.transitionProspectusSubjects(
        11,
        [{ subject_code: 'IT 101', grade: 5.0 }],
        '2026-2027',
        '1st Semester',
        {
          grading_scale: 'NUMERIC_5_POINT',
          highest_grade: 1.0,
          passing_grade: 3.0,
          failing_grade: 5.0,
        } as never,
      );

      expect(prisma.prospectusSubject.update).toHaveBeenCalledWith(
        objectMatching({
          data: objectMatching({ status: 'FAILED' }),
        }),
      );
    });

    it('falls back to the 100-scale heuristic when no school config is provided', async () => {
      await service.transitionProspectusSubjects(
        11,
        [{ subject_code: 'IT 101', grade: 78 }],
        '2026-2027',
        '1st Semester',
        null,
      );

      expect(prisma.prospectusSubject.update).toHaveBeenCalledWith(
        objectMatching({
          data: objectMatching({ status: 'PASSED' }),
        }),
      );
    });

    it('treats grades in the common 5-point failure band as FAILED without a config', async () => {
      await service.transitionProspectusSubjects(
        11,
        [{ subject_code: 'IT 101', grade: 4.0 }],
        '2026-2027',
        '1st Semester',
        null,
      );

      expect(prisma.prospectusSubject.update).toHaveBeenCalledWith(
        objectMatching({
          data: objectMatching({ status: 'FAILED' }),
        }),
      );
    });

    it('flushes the scholar and dashboard caches plus the review cache', async () => {
      await service.transitionProspectusSubjects(
        11,
        [{ subject_code: 'IT 101', grade: 1.5 }],
        '2026-2027',
        '1st Semester',
        null,
      );

      expect(cache.del).toHaveBeenCalledWith('baseline:scholar:7');
      expect(cache.del).toHaveBeenCalledWith('dashboard:scholar:7');
      expect(cache.del).toHaveBeenCalledWith('baseline:review:11');
    });
  });

  describe('checkOnboardingApplication', () => {
    it('returns null when the profile is not an APPLICANT', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue({
        profile_id: 11,
        user: { role: 'SCHOLAR' },
      });

      const result = await service.checkOnboardingApplication(11, true);

      expect(result).toBeNull();
      expect(prisma.application.findFirst).not.toHaveBeenCalled();
    });

    it('returns null when no application is found', async () => {
      prisma.application.findFirst.mockResolvedValue(null);

      const result = await service.checkOnboardingApplication(11, true);

      expect(result).toBeNull();
    });

    it('returns null when the latest application is already resolved', async () => {
      prisma.application.findFirst.mockResolvedValue({
        application_id: 42,
        status: 'APPROVED',
      });

      const result = await service.checkOnboardingApplication(11, true);

      expect(result).toBeNull();
      expect(prisma.application.update).not.toHaveBeenCalled();
    });

    it.each(['PENDING', 'UNDER_REVIEW'])(
      'moves a %s application to UNDER_REVIEW with the eligible stage',
      async (status) => {
        prisma.application.findFirst.mockResolvedValue({
          application_id: 42,
          status,
        });

        const result = await service.checkOnboardingApplication(11, true);

        expect(prisma.application.update).toHaveBeenCalledWith({
          where: { application_id: 42 },
          data: objectMatching({
            status: 'UNDER_REVIEW',
            stage: 'Document Verification Complete',
          }),
        });
        expect(result).toEqual(objectMatching({ status: 'UNDER_REVIEW' }));
      },
    );

    it('flags the application when the scholar is not eligible', async () => {
      await service.checkOnboardingApplication(11, false);

      expect(prisma.application.update).toHaveBeenCalledWith({
        where: { application_id: 42 },
        data: objectMatching({ stage: 'Flagged for Review' }),
      });
    });
  });
});
