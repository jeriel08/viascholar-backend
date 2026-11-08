import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Test, TestingModule } from '@nestjs/testing';
import { ActiveScholarsAnalyticsService } from './active-scholars-analytics.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';

// Asymmetric matchers are untyped; cast once so nested properties satisfy the linter.
const objectMatching = (shape: Record<string, unknown>) =>
  expect.objectContaining(shape) as Record<string, unknown>;

const createPrismaMock = () => ({
  scholarProfile: {
    findMany: vi.fn(),
  },
});

const makeSubject = (overrides: Record<string, unknown> = {}) => ({
  status: 'PASSED',
  grade: null,
  units: 3,
  subject_code: 'CCE101',
  year_level: 1,
  semester: '1st Semester',
  ...overrides,
});

const makeGradeReport = (overrides: Record<string, unknown> = {}) => ({
  grade_items: [],
  academic_year: '2025-2026',
  semester: '1st Semester',
  gpa: '1.75',
  status: 'APPROVED',
  evaluation_flag: null,
  appeal_status: null,
  submitted_at: new Date('2026-01-05T08:00:00.000Z'),
  ...overrides,
});

const makeDisbursement = (overrides: Record<string, unknown> = {}) => ({
  disbursement_id: 1,
  academic_year: '2025-2026',
  semester: '1st Semester',
  amount: '2000',
  status: 'SETTLED',
  date_issued: new Date('2026-01-01T08:00:00.000Z'),
  date_claimed: new Date('2026-01-03T08:00:00.000Z'),
  ...overrides,
});

const makeDocument = (overrides: Record<string, unknown> = {}) => ({
  document_id: 1,
  document_type: 'PROSPECTUS',
  status: 'VERIFIED',
  label: 'Prospectus',
  ...overrides,
});

const makeScholar = (overrides: Record<string, unknown> = {}) => ({
  profile_id: 1,
  first_name: 'Maria',
  last_name: 'Santos',
  current_year_level: 3,
  course_of_study: 'BSIT',
  school_name: null,
  academic_baseline_status: 'BASELINE_FROZEN',
  user: {
    user_id: 7,
    email: 'maria@example.com',
    role: 'SCHOLAR',
    is_active: true,
  },
  school_grading_system: {
    school_id: 1,
    school_name: 'University of Mindanao',
    grading_scale: 'NUMERIC_4_POINT',
    highest_grade: '4.0',
  },
  grade_reports: [makeGradeReport()],
  disbursements: [makeDisbursement()],
  contracts: [],
  documents: [makeDocument()],
  prospectus: {
    prospectus_id: 60,
    subjects: [makeSubject({ grade: '1.50', status: 'PASSED' })],
  },
  ...overrides,
});

describe('ActiveScholarsAnalyticsService', () => {
  let service: ActiveScholarsAnalyticsService;
  let prisma: ReturnType<typeof createPrismaMock>;

  beforeEach(async () => {
    prisma = createPrismaMock();
    prisma.scholarProfile.findMany.mockResolvedValue([makeScholar()]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ActiveScholarsAnalyticsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<ActiveScholarsAnalyticsService>(
      ActiveScholarsAnalyticsService,
    );
  });

  it('is created by the Nest testing module', () => {
    expect(service).toBeDefined();
  });

  it('queries scholars in approved review-related baseline states', async () => {
    await service.getCoordinatorActiveScholars();

    expect(prisma.scholarProfile.findMany).toHaveBeenCalledWith(
      objectMatching({
        where: objectMatching({
          OR: expect.arrayContaining([
            { user: { role: 'SCHOLAR' } },
            { applications: { some: { status: 'APPROVED' } } },
            { contracts: { some: { status: 'SIGNED' } } },
            {
              academic_baseline_status: {
                in: [
                  'BASELINE_FROZEN',
                  'PENDING_COORDINATOR_REVIEW',
                  'PENDING_HISTORICAL_CCG',
                  'PENDING_PROSPECTUS',
                ],
              },
            },
          ]),
          user: { is_active: true },
        }),
        orderBy: { profile_id: 'desc' },
      }),
    );
  });

  it('returns an empty list when there are no active scholars', async () => {
    prisma.scholarProfile.findMany.mockResolvedValue([]);

    await expect(service.getCoordinatorActiveScholars()).resolves.toEqual([]);
  });

  it('maps the profile identity, initials, and a verified baseline state', async () => {
    const [result] = await service.getCoordinatorActiveScholars();

    expect(result.id).toBe(1);
    expect(result.user_id).toBe(7);
    expect(result.name).toBe('Maria Santos');
    expect(result.initials).toBe('MS');
    expect(result.course).toBe('BSIT');
    expect(result.school).toBe('University of Mindanao');
    expect(result.year_level).toBe(3);
    expect(result.docs).toBe('1/1 Verified');
  });

  it('falls back to the email local part and placeholder initials', async () => {
    prisma.scholarProfile.findMany.mockResolvedValue([
      makeScholar({
        first_name: '',
        last_name: '',
        user: { user_id: 7, email: 'fallback@example.com', role: 'SCHOLAR' },
      }),
    ]);

    const [result] = await service.getCoordinatorActiveScholars();

    expect(result.name).toBe('fallback');
    expect(result.initials).toBe('SC');
  });

  it('falls back to a general track and the grading-system school', async () => {
    prisma.scholarProfile.findMany.mockResolvedValue([
      makeScholar({
        course_of_study: null,
        school_name: null,
        school_grading_system: {
          school_name: 'University of Mindanao',
          grading_scale: 'NUMERIC_4_POINT',
          highest_grade: '4.0',
        },
      }),
    ]);

    const [result] = await service.getCoordinatorActiveScholars();

    expect(result.course).toBe('General Track');
    expect(result.school).toBe('University of Mindanao');
  });

  it('falls back to an unassigned institution when no school exists', async () => {
    prisma.scholarProfile.findMany.mockResolvedValue([
      makeScholar({
        course_of_study: null,
        school_name: null,
        school_grading_system: null,
      }),
    ]);

    const [result] = await service.getCoordinatorActiveScholars();

    expect(result.school).toBe('Unassigned Institution');
  });

  it('defaults the year level to 1', async () => {
    prisma.scholarProfile.findMany.mockResolvedValue([
      makeScholar({ current_year_level: null }),
    ]);

    const [result] = await service.getCoordinatorActiveScholars();

    expect(result.year_level).toBe(1);
  });

  describe('GWA computation', () => {
    it('prefers the latest grade report and formats the GWA', async () => {
      prisma.scholarProfile.findMany.mockResolvedValue([
        makeScholar({
          grade_reports: [
            makeGradeReport({ gpa: '1.7532' }),
            makeGradeReport({ gpa: '2.5' }),
          ],
        }),
      ]);

      const [result] = await service.getCoordinatorActiveScholars();

      expect(result.gwa).toBe(1.75);
      expect(result.gradeHistory).toHaveLength(2);
    });

    it('reports an upward trend on a 5-point scale when the GWA improves', async () => {
      prisma.scholarProfile.findMany.mockResolvedValue([
        makeScholar({
          school_grading_system: {
            school_name: 'School',
            grading_scale: 'NUMERIC_5_POINT',
            highest_grade: '5.0',
          },
          grade_reports: [
            makeGradeReport({ gpa: '1.5' }),
            makeGradeReport({ gpa: '2.0' }),
          ],
        }),
      ]);

      const [result] = await service.getCoordinatorActiveScholars();

      expect(result.trend).toBe('up');
    });

    it('reports a downward trend on a 5-point scale when the GWA worsens', async () => {
      prisma.scholarProfile.findMany.mockResolvedValue([
        makeScholar({
          school_grading_system: {
            school_name: 'School',
            grading_scale: 'NUMERIC_5_POINT',
            highest_grade: '5.0',
          },
          grade_reports: [
            makeGradeReport({ gpa: '3.0' }),
            makeGradeReport({ gpa: '2.0' }),
          ],
        }),
      ]);

      const [result] = await service.getCoordinatorActiveScholars();

      expect(result.trend).toBe('down');
    });

    it('uses higher-is-better trend semantics on a percentage scale', async () => {
      prisma.scholarProfile.findMany.mockResolvedValue([
        makeScholar({
          school_grading_system: {
            school_name: 'School',
            grading_scale: 'PERCENTAGE_100',
            highest_grade: '100',
          },
          grade_reports: [
            makeGradeReport({ gpa: '90' }),
            makeGradeReport({ gpa: '88' }),
          ],
        }),
      ]);

      const [result] = await service.getCoordinatorActiveScholars();

      expect(result.trend).toBe('up');
    });

    it('reports down on a percentage scale when the GWA declines', async () => {
      prisma.scholarProfile.findMany.mockResolvedValue([
        makeScholar({
          school_grading_system: {
            school_name: 'School',
            grading_scale: 'PERCENTAGE_100',
            highest_grade: '100',
          },
          grade_reports: [
            makeGradeReport({ gpa: '80' }),
            makeGradeReport({ gpa: '88' }),
          ],
        }),
      ]);

      const [result] = await service.getCoordinatorActiveScholars();

      expect(result.trend).toBe('down');
    });

    it('computes a weighted GWA from graded prospectus subjects', async () => {
      prisma.scholarProfile.findMany.mockResolvedValue([
        makeScholar({
          grade_reports: [],
          prospectus: {
            prospectus_id: 60,
            subjects: [
              makeSubject({ grade: '2.0', units: 4 }),
              makeSubject({ grade: '1.0', units: 2 }),
            ],
          },
        }),
      ]);

      const [result] = await service.getCoordinatorActiveScholars();

      expect(result.gwa).toBe(1.67);
    });

    it("falls back to the school's highest grade when no subject is graded", async () => {
      prisma.scholarProfile.findMany.mockResolvedValue([
        makeScholar({
          grade_reports: [],
          prospectus: {
            prospectus_id: 60,
            subjects: [makeSubject({ grade: null, status: 'UNTAKEN' })],
          },
        }),
      ]);

      const [result] = await service.getCoordinatorActiveScholars();

      expect(result.gwa).toBe(4);
    });

    it('defaults the GWA to 90 when there is no grade data', async () => {
      prisma.scholarProfile.findMany.mockResolvedValue([
        makeScholar({
          grade_reports: [],
          prospectus: null,
          school_grading_system: null,
        }),
      ]);

      const [result] = await service.getCoordinatorActiveScholars();

      expect(result.gwa).toBe(90);
    });

    it('adds a synthetic Baseline Evaluation grade history entry', async () => {
      prisma.scholarProfile.findMany.mockResolvedValue([
        makeScholar({
          grade_reports: [],
          prospectus: {
            prospectus_id: 60,
            subjects: [makeSubject({ grade: '1.5', units: 3 })],
          },
        }),
      ]);

      const [result] = await service.getCoordinatorActiveScholars();

      expect(result.gradeHistory).toEqual([
        { term: 'Baseline Evaluation', gwa: 1.5, status: 'Passed' },
      ]);
    });
  });

  describe('document status', () => {
    it('shows the verified ratio when documents exist', async () => {
      prisma.scholarProfile.findMany.mockResolvedValue([
        makeScholar({
          documents: [
            makeDocument(),
            makeDocument({ document_id: 2, status: 'REJECTED' }),
            makeDocument({ document_id: 3, status: 'PENDING_REVIEW' }),
          ],
        }),
      ]);

      const [result] = await service.getCoordinatorActiveScholars();

      expect(result.docs).toBe('1/3 Verified');
    });

    it('shows Verified when frozen with no documents', async () => {
      prisma.scholarProfile.findMany.mockResolvedValue([
        makeScholar({
          documents: [],
          academic_baseline_status: 'BASELINE_FROZEN',
        }),
      ]);

      const [result] = await service.getCoordinatorActiveScholars();

      expect(result.docs).toBe('Verified');
    });

    it('shows Pending Docs when unfrozen with no documents', async () => {
      prisma.scholarProfile.findMany.mockResolvedValue([
        makeScholar({
          documents: [],
          academic_baseline_status: 'PENDING_PROSPECTUS',
        }),
      ]);

      const [result] = await service.getCoordinatorActiveScholars();

      expect(result.docs).toBe('Pending Docs');
    });
  });

  describe('disbursement mapping', () => {
    it('formats the latest disbursement for every status branch', async () => {
      const statuses: Array<[string, string]> = [
        ['SETTLED', 'Settled'],
        ['CLAIMED', 'Paid'],
        ['RELEASED', 'Paid'],
        ['CANCELLED', 'On hold'],
        ['PENDING', 'Pending'],
      ];

      for (const [status, label] of statuses) {
        prisma.scholarProfile.findMany.mockResolvedValue([
          makeScholar({
            disbursements: [makeDisbursement({ status })],
          }),
        ]);

        const [result] = await service.getCoordinatorActiveScholars();

        expect(result.disbursement).toBe(
          `₱${(2000).toLocaleString()} ${label}`,
        );
        expect(result.currentPayment.status).toBe(label);
      }
    });

    it('reports no disbursement when there is no payment record', async () => {
      prisma.scholarProfile.findMany.mockResolvedValue([
        makeScholar({ disbursements: [] }),
      ]);

      const [result] = await service.getCoordinatorActiveScholars();

      expect(result.disbursement).toBe('None');
      expect(result.currentPayment).toEqual({
        term: 'Current Term',
        amount: 0,
        status: 'Pending',
      });
      expect(result.paymentHistory).toEqual([]);
    });

    it('uses the claim date for payment history and falls back to the issue date', async () => {
      prisma.scholarProfile.findMany.mockResolvedValue([
        makeScholar({
          disbursements: [
            makeDisbursement({
              status: 'CLAIMED',
              date_claimed: new Date('2026-03-05T12:00:00.000Z'),
              date_issued: new Date('2026-02-01T12:00:00.000Z'),
            }),
            makeDisbursement({
              status: 'SETTLED',
              date_claimed: null,
              date_issued: new Date('2026-01-15T12:00:00.000Z'),
            }),
            makeDisbursement({
              status: 'PENDING',
              date_claimed: null,
              date_issued: null,
            }),
          ],
        }),
      ]);

      const [result] = await service.getCoordinatorActiveScholars();

      expect(result.paymentHistory.map((p) => p.date)).toEqual([
        new Date('2026-03-05T12:00:00.000Z').toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        }),
        new Date('2026-01-15T12:00:00.000Z').toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        }),
        'Pending',
      ]);
    });

    it('maps settled and claimed disbursements into history rows', async () => {
      prisma.scholarProfile.findMany.mockResolvedValue([
        makeScholar({
          disbursements: [
            makeDisbursement({ status: 'SETTLED', disbursement_id: 2 }),
            makeDisbursement({ status: 'CANCELLED', disbursement_id: 1 }),
            makeDisbursement({ status: 'PENDING', disbursement_id: 3 }),
          ],
        }),
      ]);

      const [result] = await service.getCoordinatorActiveScholars();

      expect(result.paymentHistory.map((p) => p.status)).toEqual([
        'Settled',
        'On hold',
        'Pending',
      ]);
      expect(result.paymentHistory[0].term).toBe('2025-2026 1st Semester');
      expect(result.paymentHistory[0].amount).toBe(2000);
    });
  });

  describe('grade history mapping', () => {
    it('maps grade report statuses into human labels', async () => {
      prisma.scholarProfile.findMany.mockResolvedValue([
        makeScholar({
          grade_reports: [
            makeGradeReport({ report_id: 1, status: 'APPROVED', gpa: '1.5' }),
            makeGradeReport({ report_id: 2, status: 'FLAGGED', gpa: '4.5' }),
            makeGradeReport({ report_id: 3, status: 'REJECTED', gpa: '5.0' }),
            makeGradeReport({ report_id: 4, status: 'PENDING_REVIEW' }),
          ],
        }),
      ]);

      const [result] = await service.getCoordinatorActiveScholars();

      expect(result.gradeHistory.map((g) => g.status)).toEqual([
        'Passed',
        'Failed',
        'Failed',
        'Incomplete',
      ]);
    });
  });

  describe('health determination', () => {
    const load = async (overrides: Record<string, unknown>) => {
      prisma.scholarProfile.findMany.mockResolvedValue([
        makeScholar(overrides),
      ]);
      return service.getCoordinatorActiveScholars();
    };

    it('warns when the scholar is on probation', async () => {
      const [result] = await load({
        academic_baseline_status: 'ON_PROBATION',
      });

      expect(result.health).toBe('warn');
    });

    it('warns when a grade report appeal was approved', async () => {
      const [result] = await load({
        academic_baseline_status: 'BASELINE_FROZEN',
        grade_reports: [makeGradeReport({ appeal_status: 'APPROVED' })],
      });

      expect(result.health).toBe('warn');
    });

    it('flags an unresolved flagged report as critical', async () => {
      const [result] = await load({
        grade_reports: [
          makeGradeReport({ status: 'FLAGGED', appeal_status: null }),
        ],
      });

      expect(result.health).toBe('bad');
    });

    it('flags an unresolved rejected report as critical', async () => {
      const [result] = await load({
        grade_reports: [
          makeGradeReport({ status: 'REJECTED', appeal_status: null }),
        ],
      });

      expect(result.health).toBe('bad');
    });

    it('flags an academic failure evaluation flag as critical', async () => {
      const [result] = await load({
        grade_reports: [
          makeGradeReport({
            evaluation_flag: 'ACADEMIC_FAILURE',
            appeal_status: null,
          }),
        ],
      });

      expect(result.health).toBe('bad');
    });

    it('treats an approved appeal on a flagged report as a warning', async () => {
      const [result] = await load({
        grade_reports: [
          makeGradeReport({ status: 'FLAGGED', appeal_status: 'APPROVED' }),
        ],
      });

      expect(result.health).toBe('warn');
    });

    it('flags a failed prospectus subject as critical', async () => {
      const [result] = await load({
        grade_reports: [],
        prospectus: {
          prospectus_id: 60,
          subjects: [makeSubject({ status: 'FAILED', grade: '5.0' })],
        },
      });

      expect(result.health).toBe('bad');
    });

    it('warns when a document needs re-uploading', async () => {
      const [result] = await load({
        grade_reports: [],
        documents: [makeDocument({ status: 'NEEDS_REUPLOAD' })],
      });

      expect(result.health).toBe('warn');
    });

    it('warns when a document was rejected', async () => {
      const [result] = await load({
        grade_reports: [],
        documents: [makeDocument({ status: 'REJECTED' })],
      });

      expect(result.health).toBe('warn');
    });

    it('warns when some documents are not yet verified', async () => {
      const [result] = await load({
        grade_reports: [],
        documents: [
          makeDocument(),
          makeDocument({ document_id: 2, status: 'PENDING_REVIEW' }),
        ],
      });

      expect(result.health).toBe('warn');
    });

    it('reports good health when all signals are clear', async () => {
      const [result] = await load({});

      expect(result.health).toBe('good');
    });
  });
});
