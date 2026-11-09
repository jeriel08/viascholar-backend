import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Test, TestingModule } from '@nestjs/testing';
import { CoordinatorDashboardService } from './coordinator-dashboard.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AppCacheService } from '../../common/cache/app-cache.service.js';

// Asymmetric matchers are untyped; cast once so nested properties satisfy the linter.
const anyArg = (ctor: unknown) => expect.any(ctor) as unknown;
const objectMatching = (shape: Record<string, unknown>) =>
  expect.objectContaining(shape) as Record<string, unknown>;

const createCacheMock = () => ({ wrap: vi.fn() });

const percentageSystem = {
  school_name: 'State University',
  grading_scale: 'PERCENTAGE_100',
  highest_grade: 100,
  passing_grade: 75,
  failing_grade: 50,
};

const fivePointSystem = {
  school_name: 'USP',
  grading_scale: 'NUMERIC_5_POINT',
  highest_grade: 1,
  passing_grade: 3,
  failing_grade: 5,
};

const makeScholar = (overrides: Record<string, unknown> = {}) => ({
  profile_id: 1,
  first_name: 'Ana',
  last_name: 'Cruz',
  school_name: 'School',
  course_of_study: 'BSIT',
  avatar_url: null,
  academic_baseline_status: 'ACTIVE',
  user: { user_id: 11, email: 'ana@example.com' },
  school_grading_system: percentageSystem,
  grade_reports: [],
  prospectus: { is_frozen: true, subjects: [] },
  ...overrides,
});

const makeDisbursement = (overrides: Record<string, unknown> = {}) => ({
  disbursement_id: 1,
  academic_year: '2026-2027',
  semester: '1st Semester',
  amount: 1000,
  status: 'RELEASED',
  or_document_id: 9,
  date_issued: null,
  date_claimed: null,
  scholar_profile: {
    first_name: 'Ana',
    last_name: 'Cruz',
    user: { email: 'ana@example.com' },
  },
  ...overrides,
});

describe('CoordinatorDashboardService', () => {
  let service: CoordinatorDashboardService;
  let prisma: {
    application: { findMany: ReturnType<typeof vi.fn> };
    scholarProfile: { findMany: ReturnType<typeof vi.fn> };
    termEnrollment: { findMany: ReturnType<typeof vi.fn> };
    disbursement: { findMany: ReturnType<typeof vi.fn> };
    meeting: { findMany: ReturnType<typeof vi.fn> };
    conversation: { findMany: ReturnType<typeof vi.fn> };
    systemSetting: { findFirst: ReturnType<typeof vi.fn> };
    message: { count: ReturnType<typeof vi.fn> };
  };
  let cache: ReturnType<typeof createCacheMock>;

  beforeEach(async () => {
    prisma = {
      application: { findMany: vi.fn() },
      scholarProfile: { findMany: vi.fn() },
      termEnrollment: { findMany: vi.fn() },
      disbursement: { findMany: vi.fn() },
      meeting: { findMany: vi.fn() },
      conversation: { findMany: vi.fn() },
      systemSetting: { findFirst: vi.fn() },
      message: { count: vi.fn() },
    };
    cache = createCacheMock();

    prisma.application.findMany.mockResolvedValue([]);
    prisma.scholarProfile.findMany.mockResolvedValue([]);
    prisma.termEnrollment.findMany.mockResolvedValue([]);
    prisma.disbursement.findMany.mockResolvedValue([]);
    prisma.meeting.findMany.mockResolvedValue([]);
    prisma.conversation.findMany.mockResolvedValue([]);
    prisma.systemSetting.findFirst.mockResolvedValue(null);
    prisma.message.count.mockResolvedValue(0);
    cache.wrap.mockImplementation(
      async (_key: string, factory: () => Promise<unknown>) => factory(),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CoordinatorDashboardService,
        { provide: PrismaService, useValue: prisma },
        { provide: AppCacheService, useValue: cache },
      ],
    }).compile();

    service = module.get<CoordinatorDashboardService>(
      CoordinatorDashboardService,
    );
  });

  it('caches each coordinator summary separately for 60 seconds', async () => {
    await service.getCoordinatorDashboardSummary(5);
    await service.getCoordinatorDashboardSummary(5, true);
    await service.getCoordinatorDashboardSummary(8);

    expect(cache.wrap).toHaveBeenNthCalledWith(
      1,
      'dashboard:coordinator:5',
      anyArg(Function),
      60 * 1000,
      false,
    );
    expect(cache.wrap).toHaveBeenNthCalledWith(
      2,
      'dashboard:coordinator:5',
      anyArg(Function),
      60 * 1000,
      true,
    );
    expect(cache.wrap).toHaveBeenNthCalledWith(
      3,
      'dashboard:coordinator:8',
      anyArg(Function),
      60 * 1000,
      false,
    );
  });

  it('returns zeroed KPIs and a complete applicant stage map for an empty cohort', async () => {
    const summary = await service.getCoordinatorDashboardSummary(5);

    expect(summary.kpis).toEqual({
      totalScholars: 0,
      goodStandingCount: 0,
      probationCount: 0,
      actionRequiredCount: 0,
      pendingBaselineFreezeCount: 0,
      totalApplicants: 0,
      pendingReviewApplicants: 0,
      endorsedApplicantsCount: 0,
      pendingEnrollmentsCount: 0,
      pendingOrCount: 0,
      totalDisbursedSum: 0,
      unreadMessagesCount: 0,
    });
    expect(summary.applicantStages).toEqual({
      PRE_SCREENING: 0,
      DOCUMENT_VERIFICATION: 0,
      FOR_INTERVIEW: 0,
      INTERVIEW_SCHEDULED: 0,
      ENDORSED_TO_GRANTOR: 0,
      APPROVED: 0,
      REJECTED: 0,
    });
    expect(summary.recentApplicants).toEqual([]);
    expect(summary.scholars).toEqual([]);
    expect(summary.enrollmentQueue).toEqual([]);
    expect(summary.disbursements).toEqual([]);
    expect(summary.meetings).toEqual([]);
    expect(summary.recentConversations).toEqual([]);
  });

  it('normalizes applicant stages and derives the pending review workload', async () => {
    const submitted = new Date('2026-05-01T08:00:00.000Z');
    const makeApplication = (
      id: number,
      stage: string,
      submittedAt: Date | null = submitted,
    ) => ({
      application_id: id,
      stage,
      status: 'Active',
      submitted_at: submittedAt,
      scholar_profile: {
        first_name: 'Applicant',
        last_name: `Number${id}`,
        scholarship_track: null,
        school_name: null,
        user: { email: `applicant${id}@example.com` },
      },
    });

    prisma.application.findMany.mockResolvedValue([
      makeApplication(1, 'PRE_SCREENING', null),
      makeApplication(2, 'pre_screening'),
      makeApplication(3, 'DOCUMENT_VERIFICATION'),
      makeApplication(4, 'FOR_INTERVIEW'),
      makeApplication(5, 'INTERVIEW_SCHEDULED'),
      makeApplication(6, 'ENDORSED_TO_GRANTOR'),
      makeApplication(7, 'APPROVED'),
      makeApplication(8, 'REJECTED'),
      makeApplication(9, 'UNKNOWN_STAGE'),
    ]);

    const summary = await service.getCoordinatorDashboardSummary(5);

    expect(summary.applicantStages).toEqual({
      PRE_SCREENING: 3,
      DOCUMENT_VERIFICATION: 1,
      FOR_INTERVIEW: 1,
      INTERVIEW_SCHEDULED: 1,
      ENDORSED_TO_GRANTOR: 1,
      APPROVED: 1,
      REJECTED: 1,
    });
    expect(summary.kpis.totalApplicants).toBe(9);
    expect(summary.kpis.pendingReviewApplicants).toBe(5);
    expect(summary.kpis.endorsedApplicantsCount).toBe(1);
    expect(summary.recentApplicants).toHaveLength(5);
    expect(summary.recentApplicants[0]).toEqual({
      id: 1,
      name: 'Applicant Number1',
      track: 'General',
      school: 'N/A',
      stage: 'PRE_SCREENING',
      status: 'Active',
      submitted_at: undefined,
    });
  });

  it('computes scholar health counts, baseline freezes, and dashboard projections', async () => {
    prisma.scholarProfile.findMany.mockResolvedValue([
      makeScholar({
        profile_id: 1,
        school_name: null,
        course_of_study: null,
        school_grading_system: fivePointSystem,
        grade_reports: [{ gpa: '1.5', status: 'VERIFIED' }],
        prospectus: { is_frozen: true, subjects: [] },
      }),
      makeScholar({
        profile_id: 2,
        first_name: '',
        last_name: '',
        user: { user_id: 22, email: 'jdoe@example.com' },
        school_name: 'UM',
        course_of_study: null,
        school_grading_system: null,
        academic_baseline_status: 'PENDING_COORDINATOR_REVIEW',
        grade_reports: [{ gpa: 88, status: 'VERIFIED' }],
        prospectus: null,
      }),
      makeScholar({
        profile_id: 3,
        first_name: 'Ben',
        last_name: 'Tan',
        user: { user_id: 33, email: 'ben@example.com' },
        school_name: 'X',
        grade_reports: [{ gpa: 78, status: 'FLAGGED' }],
        prospectus: { is_frozen: false, subjects: [] },
      }),
    ]);

    const summary = await service.getCoordinatorDashboardSummary(5);

    expect(summary.kpis).toEqual(
      objectMatching({
        totalScholars: 3,
        goodStandingCount: 1,
        probationCount: 1,
        actionRequiredCount: 1,
        pendingBaselineFreezeCount: 2,
      }),
    );
    expect(summary.scholars).toEqual([
      {
        id: 1,
        user_id: 11,
        name: 'Ana Cruz',
        email: 'ana@example.com',
        school: 'USP',
        course: 'General',
        gwa: 1.5,
        health: 'good',
        academic_baseline_status: 'ACTIVE',
        is_frozen: true,
      },
      {
        id: 2,
        user_id: 22,
        name: 'jdoe',
        email: 'jdoe@example.com',
        school: 'UM',
        course: 'General',
        gwa: 88,
        health: 'warn',
        academic_baseline_status: 'PENDING_COORDINATOR_REVIEW',
        is_frozen: false,
      },
      {
        id: 3,
        user_id: 33,
        name: 'Ben Tan',
        email: 'ben@example.com',
        school: 'X',
        course: 'BSIT',
        gwa: 78,
        health: 'bad',
        academic_baseline_status: 'ACTIVE',
        is_frozen: false,
      },
    ]);
  });

  it('counts only documented pending enrollments and computes disbursement and OR KPIs', async () => {
    prisma.termEnrollment.findMany.mockResolvedValue([
      {
        enrollment_id: 101,
        academic_year: '2026-2027',
        semester: '1st Semester',
        total_units: '15',
        total_assessment: '10000',
        status: 'PENDING_REVIEW',
        cor_document_id: 5,
        soa_document_id: null,
        created_at: new Date('2026-05-02T00:00:00.000Z'),
        scholar_profile: {
          first_name: 'Ana',
          last_name: 'Cruz',
          school_name: 'School',
          course_of_study: 'BSIT',
          user: { email: 'ana@example.com' },
        },
      },
      {
        enrollment_id: 102,
        academic_year: '2026-2027',
        semester: '1st Semester',
        total_units: 12,
        total_assessment: 8000,
        status: 'PENDING_REVIEW',
        cor_document_id: null,
        soa_document_id: null,
        created_at: null,
        scholar_profile: {
          first_name: 'No',
          last_name: 'Docs',
          school_name: null,
          course_of_study: null,
          user: { email: 'nodocs@example.com' },
        },
      },
      {
        enrollment_id: 103,
        academic_year: '2026-2027',
        semester: 'Summer',
        total_units: 6,
        total_assessment: 4000,
        status: 'DRAFT',
        cor_document_id: 3,
        soa_document_id: null,
        created_at: null,
        scholar_profile: {
          first_name: 'Draft',
          last_name: 'Only',
          school_name: null,
          course_of_study: null,
          user: { email: 'draft@example.com' },
        },
      },
      {
        enrollment_id: 104,
        academic_year: '2026-2027',
        semester: '2nd Semester',
        total_units: 9,
        total_assessment: 5000,
        status: 'PENDING_REVIEW',
        cor_document_id: null,
        soa_document_id: 9,
        created_at: null,
        scholar_profile: {
          first_name: 'Soa',
          last_name: 'Only',
          school_name: null,
          course_of_study: null,
          user: { email: 'soa@example.com' },
        },
      },
    ]);
    prisma.disbursement.findMany.mockResolvedValue([
      makeDisbursement({
        disbursement_id: 1,
        amount: '1000',
        status: 'RELEASED',
        or_document_id: null,
      }),
      makeDisbursement({
        disbursement_id: 2,
        amount: 500,
        status: 'CLAIMED',
        or_document_id: 9,
      }),
      makeDisbursement({
        disbursement_id: 3,
        amount: 250,
        status: 'SETTLED',
        or_document_id: null,
      }),
      makeDisbursement({
        disbursement_id: 4,
        amount: 999,
        status: 'PENDING',
        or_document_id: null,
      }),
    ]);
    prisma.message.count.mockResolvedValue(7);

    const summary = await service.getCoordinatorDashboardSummary(5);

    expect(summary.kpis.pendingEnrollmentsCount).toBe(2);
    expect(summary.kpis.pendingOrCount).toBe(1);
    expect(summary.kpis.totalDisbursedSum).toBe(1750);
    expect(summary.kpis.unreadMessagesCount).toBe(7);
    expect(summary.enrollmentQueue[0]).toEqual({
      enrollment_id: 101,
      scholar_name: 'Ana Cruz',
      term: '2026-2027 • 1st Semester',
      units: 15,
      assessment: 10000,
      status: 'PENDING_REVIEW',
      has_cor: true,
      has_soa: false,
      created_at: '2026-05-02T00:00:00.000Z',
    });
    expect(summary.enrollmentQueue[1]).toEqual(
      objectMatching({
        enrollment_id: 102,
        status: 'NO_COR_SUBMITTED',
        has_cor: false,
        has_soa: false,
      }),
    );
    expect(summary.disbursements[0]).toEqual({
      disbursement_id: 1,
      scholar_name: 'Ana Cruz',
      term: '2026-2027 • 1st Semester',
      amount: 1000,
      status: 'RELEASED',
      has_or: false,
      date_issued: null,
      date_claimed: null,
    });
    expect(prisma.message.count).toHaveBeenCalledWith({
      where: {
        conversation: { coordinator_user_id: 5 },
        sender_user_id: { not: 5 },
        is_read: false,
      },
    });
  });

  it('resolves meeting attendees and conversation previews through their fallbacks', async () => {
    prisma.meeting.findMany.mockResolvedValue([
      {
        meeting_id: 1,
        title: 'Scholar sync',
        meeting_date: new Date('2026-06-01T09:00:00.000Z'),
        meeting_time: '09:00',
        meeting_link: 'https://meet.test/1',
        status: 'SCHEDULED',
        scholar_profile: { first_name: 'Ana', last_name: 'Cruz' },
        application: null,
      },
      {
        meeting_id: 2,
        title: 'Applicant interview',
        meeting_date: new Date('2026-06-02T10:00:00.000Z'),
        meeting_time: null,
        meeting_link: null,
        status: null,
        scholar_profile: null,
        application: {
          scholar_profile: { first_name: 'App', last_name: 'Person' },
        },
      },
      {
        meeting_id: 3,
        title: 'Open slot',
        meeting_date: null,
        meeting_time: '',
        meeting_link: null,
        status: '',
        scholar_profile: null,
        application: null,
      },
    ]);
    prisma.conversation.findMany.mockResolvedValue([
      {
        conversation_id: 1,
        last_message_preview: 'Preview fallback',
        updated_at: new Date('2026-06-03T00:00:00.000Z'),
        scholar: {
          user_id: 11,
          email: 'ana@example.com',
          scholar_profile: { first_name: 'Ana', last_name: 'Cruz' },
        },
        messages: [
          {
            message_text: 'Hello there',
            sent_at: new Date('2026-06-04T00:00:00.000Z'),
          },
        ],
      },
      {
        conversation_id: 2,
        last_message_preview: 'Preview fallback',
        updated_at: new Date('2026-06-05T00:00:00.000Z'),
        scholar: {
          user_id: 12,
          email: 'nameless@example.com',
          scholar_profile: { first_name: null, last_name: null },
        },
        messages: [],
      },
      {
        conversation_id: 3,
        last_message_preview: null,
        updated_at: null,
        scholar: {
          user_id: 13,
          email: 'empty@example.com',
          scholar_profile: null,
        },
        messages: [],
      },
    ]);

    const summary = await service.getCoordinatorDashboardSummary(5);

    expect(summary.meetings).toEqual([
      {
        id: 1,
        title: 'Scholar sync',
        attendee: 'Ana Cruz',
        date: '2026-06-01T09:00:00.000Z',
        time: '09:00',
        meeting_link: 'https://meet.test/1',
        status: 'SCHEDULED',
      },
      {
        id: 2,
        title: 'Applicant interview',
        attendee: 'App Person',
        date: '2026-06-02T10:00:00.000Z',
        time: 'Scheduled Time',
        meeting_link: null,
        status: 'SCHEDULED',
      },
      {
        id: 3,
        title: 'Open slot',
        attendee: 'Applicant',
        date: undefined,
        time: 'Scheduled Time',
        meeting_link: null,
        status: 'SCHEDULED',
      },
    ]);
    expect(summary.recentConversations).toEqual([
      {
        id: 1,
        scholar_id: 11,
        scholar_name: 'Ana Cruz',
        email: 'ana@example.com',
        last_message: 'Hello there',
        last_message_at: '2026-06-04T00:00:00.000Z',
      },
      {
        id: 2,
        scholar_id: 12,
        scholar_name: 'nameless@example.com',
        email: 'nameless@example.com',
        last_message: 'Preview fallback',
        last_message_at: '2026-06-05T00:00:00.000Z',
      },
      {
        id: 3,
        scholar_id: 13,
        scholar_name: 'empty@example.com',
        email: 'empty@example.com',
        last_message: 'No messages yet',
        last_message_at: undefined,
      },
    ]);
  });

  it('scopes its queries to active applicants, active scholars, and the coordinator inbox', async () => {
    await service.getCoordinatorDashboardSummary(5);

    expect(prisma.application.findMany).toHaveBeenCalledWith(
      objectMatching({
        where: {
          stage: { not: 'Draft' },
          scholar_profile: {
            user: { role: 'APPLICANT', is_active: true },
          },
        },
        orderBy: { submitted_at: 'desc' },
      }),
    );
    expect(prisma.scholarProfile.findMany).toHaveBeenCalledWith(
      objectMatching({
        where: { user: { role: 'SCHOLAR', is_active: true } },
      }),
    );
    expect(prisma.termEnrollment.findMany).toHaveBeenCalledWith(
      objectMatching({ take: 6 }),
    );
    expect(prisma.disbursement.findMany).toHaveBeenCalledWith(
      objectMatching({ take: 6 }),
    );
    expect(prisma.meeting.findMany).toHaveBeenCalledWith(
      objectMatching({
        where: { meeting_date: { gte: anyArg(Date) } },
        take: 5,
      }),
    );
    expect(prisma.conversation.findMany).toHaveBeenCalledWith(
      objectMatching({
        where: { coordinator_user_id: 5 },
        take: 5,
      }),
    );
  });
});
