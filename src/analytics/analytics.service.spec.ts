import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AnalyticsService } from './analytics.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { ConfigService } from '@nestjs/config';
import { AppCacheService } from '../common/cache/app-cache.service.js';
import { ExplainChartDto } from './dto/analytics.dto.js';

const createPrismaMock = () => ({
  systemSetting: {
    findFirst: vi.fn(),
  },
  scholarProfile: {
    findMany: vi.fn(),
  },
  termEnrollment: {
    findMany: vi.fn(),
  },
  disbursement: {
    findMany: vi.fn(),
  },
});
const createSettingsMock = () => ({});
const createConfigMock = () => ({ get: vi.fn() });
const createCacheMock = () => ({
  wrap: vi.fn(),
  del: vi.fn(),
});

const makeGradeReport = (overrides: Record<string, unknown> = {}) => ({
  gpa: '1.75',
  status: 'APPROVED',
  submitted_at: new Date('2026-01-05T08:00:00.000Z'),
  academic_year: '2025-2026',
  semester: '1st Semester',
  document: { document_type: 'GRADE_SLIP', label: 'Grade Slip' },
  ...overrides,
});

const makeEnrollment = (overrides: Record<string, unknown> = {}) => ({
  academic_year: '2025-2026',
  semester: '1st Semester',
  total_assessment: '50000',
  status: 'ENROLLED',
  created_at: new Date('2026-01-02T08:00:00.000Z'),
  ...overrides,
});

const makeDisbursement = (overrides: Record<string, unknown> = {}) => ({
  disbursement_id: 1,
  academic_year: '2025-2026',
  semester: '1st Semester',
  amount: '2000',
  status: 'SETTLED',
  ...overrides,
});

const makeSubject = (overrides: Record<string, unknown> = {}) => ({
  units: 3,
  grade: '2.0',
  ...overrides,
});

const makeScholar = (overrides: Record<string, unknown> = {}) => ({
  profile_id: 1,
  first_name: 'Juan',
  last_name: 'Dela Cruz',
  current_year_level: 2,
  course_of_study: 'BSIT',
  scholarship_track: 'Academic Track',
  school_name: 'University of Mindanao',
  user: { user_id: 10, email: 'juan@example.com' },
  school: null,
  school_grading_system: {
    school_id: 1,
    school_name: 'University of Mindanao',
    grading_scale: 'NUMERIC_4_POINT',
    passing_grade: '2.0',
    failing_grade: '1.0',
    highest_grade: '4.0',
  },
  grade_reports: [makeGradeReport()],
  enrollments: [makeEnrollment()],
  disbursements: [makeDisbursement()],
  prospectus: { subjects: [makeSubject({ grade: '2.0' })] },
  ...overrides,
});

const makeExplainDto = (overrides: Partial<ExplainChartDto> = {}) =>
  ({
    chartType: 'FINANCIAL_DISBURSEMENT_SUMMARY',
    title: 'Disbursement Chart',
    category: 'All Scholars',
    metrics: {},
    ...overrides,
  }) as ExplainChartDto;

describe('AnalyticsService', () => {
  let service: AnalyticsService;
  let prisma: ReturnType<typeof createPrismaMock>;
  let config: ReturnType<typeof createConfigMock>;
  let cache: ReturnType<typeof createCacheMock>;

  beforeEach(async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    prisma = createPrismaMock();
    const settings = createSettingsMock();
    config = createConfigMock();
    cache = createCacheMock();

    cache.wrap.mockImplementation(
      async (_key: string, factory: () => Promise<unknown>) => factory(),
    );

    prisma.systemSetting.findFirst.mockResolvedValue({
      grade_threshold: '90',
    });
    prisma.scholarProfile.findMany.mockResolvedValue([makeScholar()]);
    prisma.termEnrollment.findMany.mockResolvedValue([
      {
        academic_year: '2024-2025',
        semester: '2nd Semester',
        total_assessment: '50000',
        status: 'ENROLLED',
      },
      {
        academic_year: '2025-2026',
        semester: '1st Semester',
        total_assessment: '50000',
        status: 'ENROLLED',
      },
    ]);
    prisma.disbursement.findMany.mockResolvedValue([
      {
        academic_year: '2025-2026',
        semester: '1st Semester',
        amount: '2000',
        status: 'SETTLED',
      },
    ]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnalyticsService,
        { provide: PrismaService, useValue: prisma },
        { provide: SettingsService, useValue: settings },
        { provide: ConfigService, useValue: config },
        { provide: AppCacheService, useValue: cache },
      ],
    }).compile();

    service = module.get<AnalyticsService>(AnalyticsService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.GEMINI_API_KEY;
  });

  const loadAnalytics = (query: Record<string, unknown> = {}) =>
    service.getDescriptiveAnalytics(query);

  it('is created by the Nest testing module', () => {
    expect(service).toBeDefined();
  });

  it('caches the report and honors the refresh flag', async () => {
    await loadAnalytics({ semester: '2nd Semester' });
    await service.getDescriptiveAnalytics({}, true);

    expect(cache.wrap).toHaveBeenNthCalledWith(
      1,
      'analytics:financial_academic_v4:all:all:all:all:2nd Semester',
      expect.any(Function),
      60 * 1000,
      false,
    );
    expect(cache.wrap).toHaveBeenNthCalledWith(
      2,
      'analytics:financial_academic_v4:all:all:all:all:all',
      expect.any(Function),
      60 * 1000,
      true,
    );
  });

  it('scopes the cache key to active filters', async () => {
    await loadAnalytics({
      schoolId: 3,
      track: 'Academic',
      course: 'BSIT',
      academicYear: '2025-2026',
      semester: '1st Semester',
    });

    expect(cache.wrap).toHaveBeenCalledWith(
      'analytics:financial_academic_v4:3:Academic:BSIT:2025-2026:1st Semester',
      expect.any(Function),
      60 * 1000,
      false,
    );
  });

  it('builds filter options strictly from recorded enrollment and disbursement terms', async () => {
    prisma.termEnrollment.findMany.mockResolvedValue([
      {
        academic_year: '2023-2024',
        semester: 'Annual',
        total_assessment: null,
        status: 'ENROLLED',
      },
      {
        academic_year: '2024-2025',
        semester: '1st Semester',
        total_assessment: null,
        status: 'ENROLLED',
      },
      {
        academic_year: '2024-2025',
        semester: 'Summer',
        total_assessment: null,
        status: 'ENROLLED',
      },
      {
        academic_year: '2025-2026',
        semester: '1st Semester',
        total_assessment: null,
        status: 'ENROLLED',
      },
    ]);
    prisma.disbursement.findMany.mockResolvedValue([
      {
        academic_year: '2024-2025',
        semester: '2nd Semester',
        amount: null,
        status: 'PENDING',
      },
      {
        academic_year: '2025-2026',
        semester: 'ALL',
        amount: null,
        status: 'PENDING',
      },
      {
        academic_year: '',
        semester: '1st Semester',
        amount: null,
        status: 'PENDING',
      },
    ]);

    const result = await loadAnalytics();

    expect(result.filterOptions.availableAcademicYears).toEqual([
      '2025-2026',
      '2024-2025',
    ]);
    expect(result.filterOptions.availableSemesters).toEqual([
      '1st Semester',
      '2nd Semester',
      'Summer',
    ]);
    expect(result.filterOptions.termsByYear).toEqual({
      '2025-2026': ['1st Semester'],
      '2024-2025': ['1st Semester', '2nd Semester', 'Summer'],
    });
  });

  it('falls back to a synthetic year and first semester when no terms are recorded', async () => {
    prisma.termEnrollment.findMany.mockResolvedValue([]);
    prisma.disbursement.findMany.mockResolvedValue([]);
    prisma.scholarProfile.findMany.mockResolvedValue([]);

    const result = await loadAnalytics();

    const currentYear = new Date().getFullYear();
    expect(result.filterOptions.availableAcademicYears).toEqual([
      `${currentYear}-${currentYear + 1}`,
    ]);
    expect(result.filterOptions.availableSemesters).toEqual(['1st Semester']);
    expect(result.filterOptions.selectedAcademicYear).toBe(
      `${currentYear}-${currentYear + 1}`,
    );
    expect(result.filterOptions.selectedSemester).toBe('1st Semester');
  });

  it('falls back to calendar order for unknown semester labels', async () => {
    prisma.termEnrollment.findMany.mockResolvedValue([
      {
        academic_year: '2025-2026',
        semester: 'Beta Term',
        total_assessment: null,
        status: 'ENROLLED',
      },
      {
        academic_year: '2025-2026',
        semester: 'Alpha Term',
        total_assessment: null,
        status: 'ENROLLED',
      },
    ]);
    prisma.disbursement.findMany.mockResolvedValue([]);

    const result = await loadAnalytics();

    expect(result.filterOptions.availableSemesters).toEqual([
      'Alpha Term',
      'Beta Term',
    ]);
  });

  it('selects the most recent year by default, honors ALL, and falls back on unknown terms', async () => {
    const byDefault = await loadAnalytics();
    expect(byDefault.filterOptions.selectedAcademicYear).toBe('2025-2026');
    expect(byDefault.filterOptions.selectedSemester).toBe('1st Semester');

    const allTerms = await loadAnalytics({ academicYear: 'ALL' });
    expect(allTerms.filterOptions.selectedAcademicYear).toBe('ALL');
    expect(allTerms.filterOptions.selectedSemester).toBe('1st Semester');

    const unknown = await loadAnalytics({
      academicYear: '1999-2000',
      semester: 'Graduation',
    });
    expect(unknown.filterOptions.selectedAcademicYear).toBe('2025-2026');
    expect(unknown.filterOptions.selectedSemester).toBe('1st Semester');
  });

  it('returns zeroed metrics and a no-scholar narrative for an empty cohort', async () => {
    prisma.termEnrollment.findMany.mockResolvedValue([]);
    prisma.disbursement.findMany.mockResolvedValue([]);
    prisma.scholarProfile.findMany.mockResolvedValue([]);

    const result = await loadAnalytics();

    expect(result.financialAspect).toEqual({
      disbursedCount: 0,
      disbursedPercent: 0,
      undisbursedCount: 0,
      undisbursedPercent: 0,
      totalSemesterAssessment: 0,
      totalDisbursedAmount: 0,
      totalPendingAmount: 0,
      totalScholarsCount: 0,
    });
    expect(result.academicAspect.totalScholarsCount).toBe(0);
    expect(result.academicAspect.standingBreakdown).toEqual({
      goodStandingCount: 0,
      goodStandingPercent: 0,
      probationCount: 0,
      probationPercent: 0,
      flaggedCount: 0,
      flaggedPercent: 0,
      complianceRate: 0,
    });
    expect(result.scholars).toEqual([]);
    expect(result.descriptiveNarratives.financialSummary).toBe(
      'No active scholars found for the selected semester and school year.',
    );
    expect(result.descriptiveNarratives.academicSummary).toBe(
      'No active scholars found for the selected semester and school year.',
    );
    expect(result.overallStats).toEqual({
      count: 0,
      mean: 0,
      standardDeviation: 0,
      variance: 0,
      min: 0,
      max: 0,
      median: 0,
      q1: 0,
      q3: 0,
      complianceRate: 0,
      goodStandingCount: 0,
      probationCount: 0,
      flaggedCount: 0,
    });
  });

  const makeMixedCohort = () => [
    makeScholar({
      profile_id: 1,
      first_name: 'Juan',
      last_name: 'Dela Cruz',
      current_year_level: 2,
      grade_reports: [
        makeGradeReport({
          gpa: '3.0',
          submitted_at: new Date('2026-02-01T08:00:00.000Z'),
        }),
      ],
      enrollments: [makeEnrollment()],
      disbursements: [makeDisbursement({ amount: '2000', status: 'SETTLED' })],
    }),
    makeScholar({
      profile_id: 2,
      first_name: 'Ana',
      last_name: 'Santos',
      current_year_level: 1,
      grade_reports: [
        makeGradeReport({
          gpa: '2.4',
          submitted_at: new Date('2026-01-01T08:00:00.000Z'),
          academic_year: '2024-2025',
          semester: '2nd Semester',
        }),
      ],
      enrollments: [],
      disbursements: [
        makeDisbursement({
          disbursement_id: 2,
          amount: '3000',
          status: 'PENDING',
        }),
      ],
    }),
    makeScholar({
      profile_id: 3,
      first_name: 'Peter',
      last_name: 'Reyes',
      current_year_level: 4,
      grade_reports: [
        makeGradeReport({
          gpa: '1.5',
          submitted_at: new Date('2026-01-01T08:00:00.000Z'),
          academic_year: '2024-2025',
          semester: '2nd Semester',
        }),
      ],
      enrollments: [makeEnrollment({ total_assessment: '40000' })],
      disbursements: [
        makeDisbursement({
          disbursement_id: 3,
          amount: '5000',
          status: 'AUTHORIZED',
        }),
      ],
    }),
  ];

  it('aggregates financial and academic metrics for a mixed cohort', async () => {
    prisma.scholarProfile.findMany.mockResolvedValue(makeMixedCohort());

    const result = await loadAnalytics();

    expect(result.scholars).toHaveLength(3);

    const [a, b, c] = result.scholars;
    expect(a).toMatchObject({
      id: 1,
      name: 'Juan Dela Cruz',
      isGraduating: false,
      enrollmentStatus: 'ENROLLED',
      gradeStatus: 'SUBMITTED',
      gwa: 3,
      standing: 'GOOD',
      disbursementStatus: 'DISBURSED',
      assessmentAmount: 50000,
      disbursedAmount: 2000,
    });
    expect(b).toMatchObject({
      id: 2,
      name: 'Ana Santos',
      isGraduating: false,
      enrollmentStatus: 'NOT_ENROLLED',
      gradeStatus: 'UNSUBMITTED',
      gwa: 2.4,
      standing: 'PROBATION',
      disbursementStatus: 'PENDING',
      assessmentAmount: 3000,
      disbursedAmount: 0,
    });
    expect(c).toMatchObject({
      id: 3,
      name: 'Peter Reyes',
      isGraduating: true,
      enrollmentStatus: 'ENROLLED',
      gradeStatus: 'UNSUBMITTED',
      gwa: 1.5,
      standing: 'AT_RISK',
      disbursementStatus: 'PENDING',
      assessmentAmount: 40000,
      disbursedAmount: 0,
    });

    expect(result.financialAspect).toEqual({
      disbursedCount: 1,
      disbursedPercent: 33.3,
      undisbursedCount: 2,
      undisbursedPercent: 66.7,
      totalSemesterAssessment: 93000,
      totalDisbursedAmount: 2000,
      totalPendingAmount: 8000,
      totalScholarsCount: 3,
    });

    expect(result.academicAspect.unsubmittedGradesCount).toBe(2);
    expect(result.academicAspect.unsubmittedGradesPercent).toBe(66.7);
    expect(result.academicAspect.submittedGradesPercent).toBe(33.3);
    expect(result.academicAspect.notEnrolledCount).toBe(1);
    expect(result.academicAspect.notEnrolledPercent).toBe(33.3);
    expect(result.academicAspect.enrolledPercent).toBe(66.7);
    expect(result.academicAspect.graduatingPercent).toBe(33.3);
    expect(result.academicAspect.standingBreakdown).toEqual({
      goodStandingCount: 1,
      goodStandingPercent: 33.3,
      probationCount: 1,
      probationPercent: 33.3,
      flaggedCount: 1,
      flaggedPercent: 33.3,
      complianceRate: 33.3,
    });
    expect(result.academicAspect.yearLevelBreakdown).toEqual([
      { yearLevel: 1, label: '1st Year', count: 1, pct: 33.3 },
      { yearLevel: 2, label: '2nd Year', count: 1, pct: 33.3 },
      { yearLevel: 3, label: '3rd Year', count: 0, pct: 0 },
      { yearLevel: 4, label: '4th Year (Graduating)', count: 1, pct: 33.3 },
    ]);

    expect(result.overallStats).toEqual({
      count: 3,
      mean: 2.3,
      standardDeviation: 0.62,
      variance: 0.38,
      min: 1.5,
      max: 3,
      median: 2.4,
      q1: 1.95,
      q3: 2.7,
      complianceRate: 33.3,
      goodStandingCount: 1,
      probationCount: 1,
      flaggedCount: 1,
    });

    expect(result.descriptiveNarratives.financialSummary).toContain(
      '1st Semester, SY 2025-2026',
    );
    expect(result.descriptiveNarratives.financialSummary).toContain('₱93,000');
    expect(result.descriptiveNarratives.academicSummary).toContain('66.7%');
    expect(result.globalThresholdPercent).toBe(90);
  });

  it('marks enrollment invalid for draft or rejected enrollment records', async () => {
    prisma.scholarProfile.findMany.mockResolvedValue([
      makeScholar({
        enrollments: [makeEnrollment({ status: 'REJECTED' })],
        disbursements: [],
      }),
      makeScholar({
        profile_id: 2,
        enrollments: [makeEnrollment({ status: 'DRAFT' })],
        disbursements: [],
      }),
    ]);

    const result = await loadAnalytics();

    expect(result.scholars.map((s) => s.enrollmentStatus)).toEqual([
      'NOT_ENROLLED',
      'NOT_ENROLLED',
    ]);
    expect(result.academicAspect.notEnrolledCount).toBe(2);
  });

  it('maps released and authorized disbursement statuses and assessment fallbacks', async () => {
    const released = makeScholar({
      profile_id: 1,
      enrollments: [],
      disbursements: [makeDisbursement({ amount: '7000', status: 'RELEASED' })],
    });
    const authorized = makeScholar({
      profile_id: 2,
      enrollments: [],
      disbursements: [
        makeDisbursement({
          disbursement_id: 2,
          amount: '9000',
          status: 'AUTHORIZED',
        }),
      ],
    });

    prisma.scholarProfile.findMany.mockResolvedValue([released, authorized]);

    const result = await loadAnalytics();

    expect(result.scholars[0]).toMatchObject({
      disbursementStatus: 'DISBURSED',
      assessmentAmount: 7000,
      disbursedAmount: 7000,
    });
    expect(result.scholars[1]).toMatchObject({
      disbursementStatus: 'PENDING',
      assessmentAmount: 9000,
      disbursedAmount: 0,
    });
    expect(result.financialAspect.totalSemesterAssessment).toBe(16000);
    expect(result.financialAspect.totalPendingAmount).toBe(9000);
  });

  it('treats a check-issued disbursement as released', async () => {
    prisma.scholarProfile.findMany.mockResolvedValue([
      makeScholar({
        enrollments: [],
        disbursements: [makeDisbursement({ status: 'CHECK_ISSUED' })],
      }),
    ]);

    const result = await loadAnalytics();

    expect(result.scholars[0].disbursementStatus).toBe('DISBURSED');
  });

  it('evaluates NUMERIC_4_POINT standing into good, probation, and at-risk', async () => {
    const good = makeScholar({
      profile_id: 1,
      grade_reports: [makeGradeReport({ gpa: '3.1' })],
    });
    const probation = makeScholar({
      profile_id: 2,
      grade_reports: [makeGradeReport({ gpa: '2.4' })],
    });
    const atRisk = makeScholar({
      profile_id: 3,
      grade_reports: [makeGradeReport({ gpa: '1.5' })],
    });

    prisma.scholarProfile.findMany.mockResolvedValue([good, probation, atRisk]);

    const result = await loadAnalytics({ academicYear: 'ALL' });

    expect(result.scholars.map((s) => [s.standing, s.gwa])).toEqual([
      ['GOOD', 3.1],
      ['PROBATION', 2.4],
      ['AT_RISK', 1.5],
    ]);
  });

  it('evaluates NUMERIC_5_POINT standing into good, probation, and at-risk', async () => {
    prisma.scholarProfile.findMany.mockResolvedValue([
      makeScholar({
        profile_id: 1,
        grade_reports: [makeGradeReport({ gpa: '2.0' })],
        school_grading_system: {
          school_name: 'School',
          grading_scale: 'NUMERIC_5_POINT',
          passing_grade: '3.0',
          failing_grade: '5.0',
          highest_grade: '1.0',
        },
      }),
      makeScholar({
        profile_id: 2,
        grade_reports: [makeGradeReport({ gpa: '2.8' })],
        school_grading_system: {
          school_name: 'School',
          grading_scale: 'NUMERIC_5_POINT',
          passing_grade: '3.0',
          failing_grade: '5.0',
          highest_grade: '1.0',
        },
      }),
      makeScholar({
        profile_id: 3,
        grade_reports: [makeGradeReport({ gpa: '4.0' })],
        school_grading_system: {
          school_name: 'School',
          grading_scale: 'NUMERIC_5_POINT',
          passing_grade: '3.0',
          failing_grade: '5.0',
          highest_grade: '1.0',
        },
      }),
    ]);

    const result = await loadAnalytics();

    expect(result.scholars.map((s) => s.standing)).toEqual([
      'GOOD',
      'PROBATION',
      'AT_RISK',
    ]);
  });

  it('evaluates percentage scale standing into good, probation, and at-risk', async () => {
    const makePercentageScholar = (profile_id: number, gpa: string) =>
      makeScholar({
        profile_id,
        grade_reports: [makeGradeReport({ gpa })],
        school_grading_system: {
          school_name: 'School',
          grading_scale: 'PERCENTAGE_100',
          passing_grade: '75',
          failing_grade: '50',
          highest_grade: '100',
        },
      });

    prisma.scholarProfile.findMany.mockResolvedValue([
      makePercentageScholar(1, '95'),
      makePercentageScholar(2, '80'),
      makePercentageScholar(3, '60'),
    ]);

    const result = await loadAnalytics();

    expect(result.scholars.map((s) => s.standing)).toEqual([
      'GOOD',
      'PROBATION',
      'AT_RISK',
    ]);
  });

  it('falls back to the global threshold when no school config exists', async () => {
    prisma.scholarProfile.findMany.mockResolvedValue([
      makeScholar({
        profile_id: 1,
        grade_reports: [makeGradeReport({ gpa: '95' })],
        school_grading_system: null,
      }),
      makeScholar({
        profile_id: 2,
        grade_reports: [makeGradeReport({ gpa: '80' })],
        school_grading_system: null,
      }),
    ]);

    const result = await loadAnalytics();

    expect(result.scholars.map((s) => s.standing)).toEqual([
      'GOOD',
      'PROBATION',
    ]);
  });

  it('computes a weighted prospectus GWA when there is no valid grade report', async () => {
    prisma.scholarProfile.findMany.mockResolvedValue([
      makeScholar({
        grade_reports: [],
        prospectus: {
          subjects: [
            makeSubject({ grade: '2.0', units: 4 }),
            makeSubject({ grade: '1.0', units: 2 }),
          ],
        },
      }),
    ]);

    const result = await loadAnalytics();

    expect(result.scholars[0].gwa).toBe(1.67);
  });

  it('excludes application-phase Form 9 reports from submitted grades and GWA', async () => {
    prisma.scholarProfile.findMany.mockResolvedValue([
      makeScholar({
        grade_reports: [
          makeGradeReport({
            gpa: '95',
            semester: 'Annual',
            document: { document_type: 'FORM_9', label: 'Form 9' },
          }),
        ],
        prospectus: { subjects: [] },
      }),
    ]);

    const result = await loadAnalytics();

    expect(result.scholars[0]).toMatchObject({
      gradeStatus: 'UNSUBMITTED',
      gwa: 0,
    });
  });

  it('prefers a term-matching grade report over a newer off-term report', async () => {
    prisma.scholarProfile.findMany.mockResolvedValue([
      makeScholar({
        grade_reports: [
          makeGradeReport({
            gpa: '1.0',
            academic_year: '2024-2025',
            semester: '2nd Semester',
            submitted_at: new Date('2026-02-01T08:00:00.000Z'),
          }),
          makeGradeReport({
            gpa: '2.5',
            academic_year: '2025-2026',
            semester: '1st Semester',
            submitted_at: new Date('2026-01-01T08:00:00.000Z'),
          }),
        ],
      }),
    ]);

    const result = await loadAnalytics();

    expect(result.scholars[0].gwa).toBe(2.5);
    expect(result.scholars[0].gradeStatus).toBe('SUBMITTED');
  });

  it('clamps out-of-range year levels into the 1-4 distribution buckets', async () => {
    prisma.scholarProfile.findMany.mockResolvedValue([
      makeScholar({ profile_id: 1, current_year_level: 7 }),
      makeScholar({ profile_id: 2, current_year_level: null }),
      makeScholar({ profile_id: 3, current_year_level: 3 }),
    ]);

    const result = await loadAnalytics();

    expect(
      result.academicAspect.yearLevelBreakdown.map((item) => item.count),
    ).toEqual([1, 0, 1, 1]);
  });

  it('aggregates across every term when the query selects ALL', async () => {
    prisma.termEnrollment.findMany.mockResolvedValue([
      {
        academic_year: '2024-2025',
        semester: '1st Semester',
        total_assessment: '10000',
        status: 'ENROLLED',
      },
      {
        academic_year: '2025-2026',
        semester: '1st Semester',
        total_assessment: '20000',
        status: 'ENROLLED',
      },
    ]);
    prisma.scholarProfile.findMany.mockResolvedValue([
      makeScholar({
        enrollments: [
          makeEnrollment({
            academic_year: '2024-2025',
            semester: '1st Semester',
            total_assessment: '10000',
          }),
          makeEnrollment({
            academic_year: '2025-2026',
            semester: '1st Semester',
            total_assessment: '20000',
          }),
        ],
        disbursements: [
          makeDisbursement({
            academic_year: '2024-2025',
            amount: '1000',
            status: 'SETTLED',
          }),
          makeDisbursement({
            disbursement_id: 2,
            academic_year: '2025-2026',
            amount: '1500',
            status: 'CLAIMED',
          }),
        ],
      }),
    ]);

    const result = await loadAnalytics({ academicYear: 'ALL' });

    expect(result.filterOptions.selectedAcademicYear).toBe('ALL');
    // The first matching released disbursement is counted for the scholar,
    // even when several terms match the ALL filter.
    expect(result.scholars[0].disbursementStatus).toBe('DISBURSED');
    expect(result.financialAspect.totalDisbursedAmount).toBe(1000);
  });

  it('uses the configured global grade threshold', async () => {
    prisma.systemSetting.findFirst.mockResolvedValue({
      grade_threshold: '85',
    });

    const result = await loadAnalytics();

    expect(result.globalThresholdPercent).toBe(85);
  });

  it('shows 1st Semester and SY in the financial narrative for a single year', async () => {
    const result = await loadAnalytics();

    expect(result.descriptiveNarratives.financialSummary).toContain(
      '1st Semester, SY 2025-2026',
    );
  });

  it('includes archived scholars in historical analytics metrics and roster metadata', async () => {
    prisma.scholarProfile.findMany.mockResolvedValue([
      makeScholar({
        profile_id: 99,
        archived_at: new Date('2026-03-01T00:00:00.000Z'),
        archive_reason: 'FAILED_SECOND_CHANCE',
      }),
    ]);

    const result = await loadAnalytics();

    expect(prisma.scholarProfile.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.not.objectContaining({ archived_at: null }),
      }),
    );
    expect(result.financialAspect.totalScholarsCount).toBe(1);
    expect(result.academicAspect.totalScholarsCount).toBe(1);
    expect(result.scholars).toHaveLength(1);
    expect(result.scholars[0]).toMatchObject({
      id: 99,
      isArchived: true,
      archiveReason: 'FAILED_SECOND_CHANCE',
    });
  });

  it('classifies a 2nd-chance disqualified scholar with a passing numeric grade as AT_RISK', async () => {
    prisma.termEnrollment.findMany.mockResolvedValue([
      {
        academic_year: '2024',
        semester: 'Summer',
        total_assessment: '12699',
        status: 'COMPLETED',
      },
    ]);
    prisma.disbursement.findMany.mockResolvedValue([
      {
        academic_year: '2024',
        semester: 'Summer',
        amount: '12699',
        status: 'SETTLED',
      },
    ]);
    prisma.scholarProfile.findMany.mockResolvedValue([
      makeScholar({
        profile_id: 101,
        academic_baseline_status: 'DISCONTINUED',
        archived_at: new Date('2026-03-01T00:00:00.000Z'),
        archive_reason: 'FAILED_SECOND_CHANCE',
        enrollments: [
          makeEnrollment({
            academic_year: '2023-2024',
            semester: 'Summer',
            total_assessment: '12699',
            status: 'COMPLETED',
          }),
        ],
        disbursements: [
          makeDisbursement({
            academic_year: '2023-2024',
            semester: 'Summer',
            amount: '12699',
            status: 'SETTLED',
          }),
        ],
        grade_reports: [
          makeGradeReport({
            gpa: '3.0',
            academic_year: '2024',
            semester: 'Summer',
            status: 'FLAGGED',
            evaluation_flag: 'BELOW_PASSING_MARK',
            is_eligible: false,
            appeal_status: 'DENIED',
          }),
        ],
      }),
    ]);

    const result = await loadAnalytics({
      academicYear: '2024',
      semester: 'Summer',
    });

    expect(result.scholars[0].standing).toBe('AT_RISK');
    expect(result.academicAspect.standingBreakdown).toMatchObject({
      goodStandingCount: 0,
      probationCount: 0,
      flaggedCount: 1,
    });
  });

  it('produces dynamic narratives without 0% (0 scholars) or 1 scholars when 100% complete', async () => {
    prisma.scholarProfile.findMany.mockResolvedValue([
      makeScholar({
        profile_id: 102,
        current_year_level: 2,
        enrollments: [makeEnrollment({ total_assessment: '12699' })],
        disbursements: [makeDisbursement({ amount: '12699', status: 'SETTLED' })],
        grade_reports: [
          makeGradeReport({
            gpa: '3.8',
            status: 'APPROVED',
            is_eligible: true,
          }),
        ],
      }),
    ]);

    const result = await loadAnalytics();

    expect(result.descriptiveNarratives.financialSummary).not.toMatch(/\b0%/);
    expect(result.descriptiveNarratives.financialSummary).not.toContain('0 scholars');
    expect(result.descriptiveNarratives.financialSummary).not.toContain('1 scholars');
    expect(result.descriptiveNarratives.financialSummary).toContain('1 scholar');
    expect(result.descriptiveNarratives.academicSummary).not.toMatch(/\b0%/);
    expect(result.descriptiveNarratives.academicSummary).not.toContain('1 scholars');
    expect(result.descriptiveNarratives.academicSummary).toContain(
      '1 in good standing',
    );
  });

  it('unifies different school year formats and single-year Summer into a canonical SY filter', async () => {
    prisma.termEnrollment.findMany.mockResolvedValue([
      {
        academic_year: '2023-2024',
        semester: '1st Semester',
        total_assessment: '30000',
        status: 'APPROVED',
      },
      {
        academic_year: '2023-24',
        semester: '2nd Semester',
        total_assessment: '25000',
        status: 'APPROVED',
      },
      {
        academic_year: '2024',
        semester: 'Summer',
        total_assessment: '12699',
        status: 'COMPLETED',
      },
    ]);
    prisma.disbursement.findMany.mockResolvedValue([
      {
        academic_year: 'SY 2023-24',
        semester: '2nd Semester',
        amount: '25000',
        status: 'SETTLED',
      },
    ]);
    prisma.scholarProfile.findMany.mockResolvedValue([
      makeScholar({
        profile_id: 201,
        enrollments: [
          makeEnrollment({
            academic_year: '2023-24',
            semester: '2nd Semester',
            total_assessment: '25000',
            status: 'APPROVED',
          }),
        ],
        disbursements: [
          makeDisbursement({
            academic_year: 'SY 2023-24',
            semester: '2nd Semester',
            amount: '25000',
            status: 'SETTLED',
          }),
        ],
        grade_reports: [
          makeGradeReport({
            gpa: '3.6',
            academic_year: '2023-2024',
            semester: '2nd Semester',
            status: 'APPROVED',
            is_eligible: true,
          }),
        ],
      }),
    ]);

    const shortYearQuery = await loadAnalytics({
      academicYear: '2023-24',
      semester: '2nd Semester',
    });

    expect(shortYearQuery.filterOptions.availableAcademicYears).toEqual([
      '2023-2024',
    ]);
    expect(shortYearQuery.filterOptions.termsByYear).toEqual({
      '2023-2024': ['1st Semester', '2nd Semester', 'Summer'],
    });
    expect(shortYearQuery.filterOptions.selectedAcademicYear).toBe('2023-2024');
    expect(shortYearQuery.filterOptions.selectedSemester).toBe('2nd Semester');
    expect(shortYearQuery.financialAspect).toMatchObject({
      totalSemesterAssessment: 25000,
      totalDisbursedAmount: 25000,
      disbursedCount: 1,
    });
    expect(shortYearQuery.scholars[0]).toMatchObject({
      enrollmentStatus: 'ENROLLED',
      gradeStatus: 'SUBMITTED',
      disbursementStatus: 'DISBURSED',
    });

    const fullYearQuery = await loadAnalytics({
      academicYear: '2023-2024',
      semester: '2nd Semester',
    });
    expect(fullYearQuery.filterOptions.selectedAcademicYear).toBe('2023-2024');
    expect(fullYearQuery.financialAspect.totalDisbursedAmount).toBe(25000);
  });

  describe('explainChartWithAi', () => {
    const metrics = {
      disbursedPercent: 65,
      undisbursedPercent: 35,
      disbursedCount: 13,
      undisbursedCount: 7,
      totalSemesterAssessment: 130000,
      totalDisbursedAmount: 84500,
      totalPendingAmount: 45500,
    };

    const makeFetchResponse = (ok: boolean, body: unknown) =>
      ({ ok, json: () => Promise.resolve(body) }) as Response;

    type HeuristicResult = {
      summary: string;
      statisticalInterpretation: string;
      recommendations: string[];
      keyHighlights: string[];
    };

    it('parses a fenced Gemini JSON response when the API is configured', async () => {
      config.get.mockReturnValue('gemini-key');
      const fetchMock = vi.fn().mockResolvedValue(
        makeFetchResponse(true, {
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: '```json\n{"summary": "S", "statisticalInterpretation": "I", "recommendations": ["R1"], "keyHighlights": ["H1"]}\n```',
                  },
                ],
              },
            },
          ],
        }),
      );
      vi.stubGlobal('fetch', fetchMock);

      const result = (await service.explainChartWithAi(
        makeExplainDto({ metrics, title: 'Disbursement' }),
      )) as HeuristicResult;

      expect(fetchMock).toHaveBeenCalledWith(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=gemini-key',
        expect.objectContaining({ method: 'POST' }),
      );
      const bodyArg = fetchMock.mock.calls[0][1] as { body: string };
      const body = JSON.parse(bodyArg.body) as {
        contents: [{ parts: [{ text: string }] }];
      };
      expect(body.contents[0].parts[0].text).toContain('Disbursement');
      expect(body.contents[0].parts[0].text).toContain(
        '"disbursedPercent": 65',
      );
      expect(result).toEqual({
        summary: 'S',
        statisticalInterpretation: 'I',
        recommendations: ['R1'],
        keyHighlights: ['H1'],
      });
    });

    it('falls back to the heuristic when the Gemini response is not ok', async () => {
      config.get.mockReturnValue('gemini-key');
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValue(makeFetchResponse(false, { error: 'denied' })),
      );

      const result = (await service.explainChartWithAi(
        makeExplainDto({ metrics }),
      )) as HeuristicResult;

      expect(result.summary).toContain('65% of scholars (13)');
    });

    it('falls back to the heuristic when fetch fails', async () => {
      config.get.mockReturnValue('gemini-key');
      vi.stubGlobal(
        'fetch',
        vi.fn().mockRejectedValue(new Error('network down')),
      );

      const result = (await service.explainChartWithAi(
        makeExplainDto({ metrics }),
      )) as HeuristicResult;

      expect(result.summary).toContain('65% of scholars (13)');
    });

    it('falls back to the heuristic when the model returns no text', async () => {
      config.get.mockReturnValue('gemini-key');
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          makeFetchResponse(true, {
            candidates: [{ content: { parts: [] } }],
          }),
        ),
      );

      const result = (await service.explainChartWithAi(
        makeExplainDto({ metrics }),
      )) as HeuristicResult;

      expect(result.summary).toContain('65% of scholars (13)');
    });

    it('does not call fetch and uses the heuristic when no API key is configured', async () => {
      config.get.mockReturnValue(undefined);
      delete process.env.GEMINI_API_KEY;
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const result = (await service.explainChartWithAi(
        makeExplainDto({ metrics }),
      )) as HeuristicResult;

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.summary).toContain('65% of scholars (13)');
    });

    it('builds a plain-English heuristic for the financial summary chart', () => {
      const result = service['generateStatisticalHeuristicExplanation'](
        makeExplainDto({ metrics }),
      );

      expect(result.summary).toBe(
        '65% of scholars (13) have received their semester disbursement, while 35% (7) are waiting for funds release.',
      );
      expect(result.statisticalInterpretation).toContain('₱130,000');
      expect(result.recommendations).toHaveLength(2);
      expect(result.keyHighlights).toEqual([
        'Disbursed Scholars: 65% (13)',
        'Undisbursed Scholars: 35% (7)',
        'Funds Disbursed: ₱84,500',
        'Pending Imbursement: ₱45,500',
      ]);
    });

    it('builds a plain-English heuristic for the academic compliance chart', () => {
      const result = service['generateStatisticalHeuristicExplanation'](
        makeExplainDto({
          chartType: 'ACADEMIC_COMPLIANCE_SUMMARY',
          metrics: {
            unsubmittedGradesPercent: 40,
            unsubmittedGradesCount: 8,
            notEnrolledPercent: 25,
            notEnrolledCount: 5,
            graduatingPercent: 10,
            graduatingCount: 2,
          },
        }),
      );

      expect(result.summary).toContain('25% of scholars have not yet enrolled');
      expect(result.recommendations).toHaveLength(3);
      expect(result.keyHighlights).toEqual([
        'Unsubmitted Grades: 40% (8 scholars)',
        'Not Enrolled Yet: 25% (5 scholars)',
        'Graduating Scholars: 10% (2 scholars)',
      ]);
    });

    it('builds a plain-English heuristic for the academic standing chart', () => {
      const result = service['generateStatisticalHeuristicExplanation'](
        makeExplainDto({
          chartType: 'ACADEMIC_STANDING',
          metrics: {
            goodStandingCount: 15,
            probationCount: 2,
            flaggedCount: 3,
            complianceRate: 75,
          },
        }),
      );

      expect(result.summary).toContain(
        '75% of scholars meet the required grade retention',
      );
      expect(result.keyHighlights).toEqual([
        'Meeting Retention Mark: 75%',
        'Good Standing: 15',
        'On Watch / Probation: 2',
        'At Risk: 3',
      ]);
    });

    it('builds a plain-English heuristic for the year level distribution chart', () => {
      const yearLevelBreakdown = [
        { yearLevel: 1, label: '1st Year', count: 6, pct: 30 },
        { yearLevel: 4, label: '4th Year (Graduating)', count: 2, pct: 10 },
      ];

      const result = service['generateStatisticalHeuristicExplanation'](
        makeExplainDto({
          chartType: 'YEAR_LEVEL_DISTRIBUTION',
          metrics: { yearLevelBreakdown },
        }),
      );

      expect(result.keyHighlights).toEqual([
        '1st Year: 6 (30%)',
        '4th Year (Graduating): 2 (10%)',
      ]);
    });

    it('returns the generic heuristic for an unknown chart type', () => {
      const result = service['generateStatisticalHeuristicExplanation'](
        makeExplainDto({ chartType: 'UNKNOWN_CHART' }),
      );

      expect(result.summary).toBe(
        'Descriptive summary of scholarship operational metrics for the current semester.',
      );
      expect(result.keyHighlights).toEqual(['Status: Active Semester Report']);
    });
  });
});
