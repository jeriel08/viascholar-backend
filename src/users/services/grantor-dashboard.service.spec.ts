import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Test, TestingModule } from '@nestjs/testing';
import { GrantorDashboardService } from './grantor-dashboard.service.js';
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
  status: 'PENDING',
  or_document_id: null,
  date_issued: null,
  date_claimed: null,
  scholar_profile: {
    first_name: 'Ana',
    last_name: 'Cruz',
    user: { email: 'ana@example.com' },
  },
  ...overrides,
});

describe('GrantorDashboardService', () => {
  let service: GrantorDashboardService;
  let prisma: {
    application: {
      findMany: ReturnType<typeof vi.fn>;
      count: ReturnType<typeof vi.fn>;
    };
    gradeReport: { findMany: ReturnType<typeof vi.fn> };
    disbursement: { findMany: ReturnType<typeof vi.fn> };
    scholarProfile: { findMany: ReturnType<typeof vi.fn> };
    meeting: { findMany: ReturnType<typeof vi.fn> };
    conversation: { findMany: ReturnType<typeof vi.fn> };
    systemSetting: { findFirst: ReturnType<typeof vi.fn> };
  };
  let cache: ReturnType<typeof createCacheMock>;

  beforeEach(async () => {
    prisma = {
      application: { findMany: vi.fn(), count: vi.fn() },
      gradeReport: { findMany: vi.fn() },
      disbursement: { findMany: vi.fn() },
      scholarProfile: { findMany: vi.fn() },
      meeting: { findMany: vi.fn() },
      conversation: { findMany: vi.fn() },
      systemSetting: { findFirst: vi.fn() },
    };
    cache = createCacheMock();

    prisma.application.findMany.mockResolvedValue([]);
    prisma.application.count.mockResolvedValue(0);
    prisma.gradeReport.findMany.mockResolvedValue([]);
    prisma.disbursement.findMany.mockResolvedValue([]);
    prisma.scholarProfile.findMany.mockResolvedValue([]);
    prisma.meeting.findMany.mockResolvedValue([]);
    prisma.conversation.findMany.mockResolvedValue([]);
    prisma.systemSetting.findFirst.mockResolvedValue(null);
    cache.wrap.mockImplementation(
      async (_key: string, factory: () => Promise<unknown>) => factory(),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GrantorDashboardService,
        { provide: PrismaService, useValue: prisma },
        { provide: AppCacheService, useValue: cache },
      ],
    }).compile();

    service = module.get<GrantorDashboardService>(GrantorDashboardService);
  });

  it('caches each grantor summary separately for 60 seconds', async () => {
    await service.getGrantorDashboardSummary(4);
    await service.getGrantorDashboardSummary(4, true);
    await service.getGrantorDashboardSummary(6);

    expect(cache.wrap).toHaveBeenNthCalledWith(
      1,
      'dashboard:grantor:4',
      anyArg(Function),
      60 * 1000,
      false,
    );
    expect(cache.wrap).toHaveBeenNthCalledWith(
      2,
      'dashboard:grantor:4',
      anyArg(Function),
      60 * 1000,
      true,
    );
    expect(cache.wrap).toHaveBeenNthCalledWith(
      3,
      'dashboard:grantor:6',
      anyArg(Function),
      60 * 1000,
      false,
    );
  });

  it('returns zeroed KPIs and empty collections when there is no data', async () => {
    const summary = await service.getGrantorDashboardSummary(4);

    expect(summary.kpis).toEqual({
      endorsedApplicantsCount: 0,
      totalApplicants: 0,
      pendingAppealsCount: 0,
      pendingDisbursementsCount: 0,
      pendingDisbursementsSum: 0,
      totalScholars: 0,
      goodStandingCount: 0,
      probationCount: 0,
      actionRequiredCount: 0,
      totalDisbursedSum: 0,
      pendingOrCount: 0,
    });
    expect(summary.endorsedApplicants).toEqual([]);
    expect(summary.pendingAppeals).toEqual([]);
    expect(summary.pendingDisbursements).toEqual([]);
    expect(summary.scholars).toEqual([]);
    expect(summary.meetings).toEqual([]);
    expect(summary.recentConversations).toEqual([]);
  });

  it('maps endorsed applicants awaiting the grantor verdict', async () => {
    prisma.application.findMany.mockResolvedValue([
      {
        application_id: 1,
        stage: 'ENDORSED_TO_GRANTOR',
        status: 'Pending',
        submitted_at: new Date('2026-05-01T00:00:00.000Z'),
        stage_updated_at: new Date('2026-05-02T00:00:00.000Z'),
        scholar_profile: {
          first_name: 'Ana',
          last_name: 'Cruz',
          scholarship_track: 'Academic',
          course_of_study: 'BSIT',
          school_name: 'UM',
          user: { email: 'ana@example.com' },
        },
      },
      {
        application_id: 2,
        stage: 'ENDORSED_TO_GRANTOR',
        status: 'Pending',
        submitted_at: null,
        stage_updated_at: null,
        scholar_profile: {
          first_name: '',
          last_name: '',
          scholarship_track: null,
          course_of_study: null,
          school_name: null,
          user: { email: 'fallback@example.com' },
        },
      },
    ]);
    prisma.application.count.mockResolvedValue(14);

    const summary = await service.getGrantorDashboardSummary(4);

    expect(summary.kpis.endorsedApplicantsCount).toBe(2);
    expect(summary.kpis.totalApplicants).toBe(14);
    expect(summary.endorsedApplicants).toEqual([
      {
        id: 1,
        name: 'Ana Cruz',
        email: 'ana@example.com',
        track: 'Academic',
        school: 'UM',
        stage: 'ENDORSED_TO_GRANTOR',
        status: 'Pending',
        submitted_at: '2026-05-01T00:00:00.000Z',
        stage_updated_at: '2026-05-02T00:00:00.000Z',
      },
      {
        id: 2,
        name: 'fallback@example.com',
        email: 'fallback@example.com',
        track: 'General',
        school: 'N/A',
        stage: 'ENDORSED_TO_GRANTOR',
        status: 'Pending',
        submitted_at: undefined,
        stage_updated_at: null,
      },
    ]);
  });

  it('maps pending appeals with note and timestamp fallbacks', async () => {
    prisma.gradeReport.findMany.mockResolvedValue([
      {
        report_id: 91,
        academic_year: '2025-2026',
        semester: '2nd Semester',
        gpa: '2.25',
        appeal_status: 'PENDING_GRANTOR',
        appeal_notes: 'Family hardship',
        appeal_submitted_at: new Date('2026-06-01T00:00:00.000Z'),
        submitted_at: new Date('2026-05-01T00:00:00.000Z'),
        scholar_profile: {
          first_name: 'Ana',
          last_name: 'Cruz',
          school_name: 'UM',
          course_of_study: 'BSIT',
          user: { email: 'ana@example.com' },
        },
      },
      {
        report_id: 92,
        academic_year: '2025-2026',
        semester: '1st Semester',
        gpa: 1.8,
        appeal_status: 'PENDING_GRANTOR',
        appeal_notes: null,
        appeal_submitted_at: null,
        submitted_at: new Date('2026-04-01T00:00:00.000Z'),
        scholar_profile: {
          first_name: '',
          last_name: '',
          school_name: null,
          course_of_study: null,
          user: { email: 'appeal@example.com' },
        },
      },
    ]);

    const summary = await service.getGrantorDashboardSummary(4);

    expect(summary.kpis.pendingAppealsCount).toBe(2);
    expect(summary.pendingAppeals).toEqual([
      {
        id: 91,
        scholar_name: 'Ana Cruz',
        school: 'UM',
        course: 'BSIT',
        term: '2025-2026 • 2nd Semester',
        gpa: 2.25,
        appeal_status: 'PENDING_GRANTOR',
        appeal_notes: 'Family hardship',
        submitted_at: '2026-06-01T00:00:00.000Z',
      },
      {
        id: 92,
        scholar_name: 'appeal@example.com',
        school: 'N/A',
        course: 'N/A',
        term: '2025-2026 • 1st Semester',
        gpa: 1.8,
        appeal_status: 'PENDING_GRANTOR',
        appeal_notes: 'No statement provided',
        submitted_at: '2026-04-01T00:00:00.000Z',
      },
    ]);
  });

  it('sums pending disbursements and recent release totals while tracking OR gaps', async () => {
    prisma.disbursement.findMany
      .mockResolvedValueOnce([
        makeDisbursement({ disbursement_id: 1, amount: '1000.50' }),
        makeDisbursement({
          disbursement_id: 2,
          amount: 2000,
          status: 'AUTHORIZED',
          or_document_id: 8,
          date_issued: new Date('2026-05-10T00:00:00.000Z'),
        }),
      ])
      .mockResolvedValueOnce([
        makeDisbursement({
          disbursement_id: 3,
          amount: 1000,
          status: 'RELEASED',
          or_document_id: null,
        }),
        makeDisbursement({
          disbursement_id: 4,
          amount: 500,
          status: 'CLAIMED',
          or_document_id: 9,
        }),
        makeDisbursement({
          disbursement_id: 5,
          amount: 250,
          status: 'SETTLED',
          or_document_id: null,
        }),
        makeDisbursement({
          disbursement_id: 6,
          amount: 999,
          status: 'PENDING',
          or_document_id: null,
        }),
      ]);

    const summary = await service.getGrantorDashboardSummary(4);

    expect(summary.kpis.pendingDisbursementsCount).toBe(2);
    expect(summary.kpis.pendingDisbursementsSum).toBe(3000.5);
    expect(summary.kpis.totalDisbursedSum).toBe(1750);
    expect(summary.kpis.pendingOrCount).toBe(1);
    expect(summary.pendingDisbursements).toEqual([
      {
        disbursement_id: 1,
        scholar_name: 'Ana Cruz',
        term: '2026-2027 • 1st Semester',
        amount: 1000.5,
        status: 'PENDING',
        has_or: false,
        date_issued: null,
        date_claimed: null,
      },
      {
        disbursement_id: 2,
        scholar_name: 'Ana Cruz',
        term: '2026-2027 • 1st Semester',
        amount: 2000,
        status: 'AUTHORIZED',
        has_or: true,
        date_issued: '2026-05-10T00:00:00.000Z',
        date_claimed: null,
      },
    ]);
  });

  it('computes scholar health against the configured grade threshold', async () => {
    prisma.systemSetting.findFirst.mockResolvedValue({
      setting_id: 1,
      grade_threshold: '85',
    });
    prisma.scholarProfile.findMany.mockResolvedValue([
      makeScholar({
        profile_id: 1,
        school_name: null,
        course_of_study: null,
        school_grading_system: fivePointSystem,
        grade_reports: [{ gpa: '1.5', status: 'VERIFIED' }],
      }),
      makeScholar({
        profile_id: 2,
        first_name: '',
        last_name: '',
        user: { user_id: 22, email: 'jdoe@example.com' },
        school_name: 'UM',
        course_of_study: null,
        school_grading_system: null,
        grade_reports: [{ gpa: 80, status: 'VERIFIED' }],
      }),
      makeScholar({
        profile_id: 3,
        first_name: 'Ben',
        last_name: 'Tan',
        user: { user_id: 33, email: 'ben@example.com' },
        school_name: 'X',
        grade_reports: [{ gpa: 70, status: 'FLAGGED' }],
      }),
    ]);

    const summary = await service.getGrantorDashboardSummary(4);

    expect(summary.kpis).toEqual(
      objectMatching({
        totalScholars: 3,
        goodStandingCount: 1,
        probationCount: 1,
        actionRequiredCount: 1,
      }),
    );
    expect(summary.scholars).toEqual([
      {
        id: 1,
        userId: 11,
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
        userId: 22,
        name: 'jdoe',
        email: 'jdoe@example.com',
        school: 'UM',
        course: 'General',
        gwa: 80,
        health: 'warn',
        academic_baseline_status: 'ACTIVE',
        is_frozen: true,
      },
      {
        id: 3,
        userId: 33,
        name: 'Ben Tan',
        email: 'ben@example.com',
        school: 'X',
        course: 'BSIT',
        gwa: 70,
        health: 'bad',
        academic_baseline_status: 'ACTIVE',
        is_frozen: true,
      },
    ]);
  });

  it('resolves executive meeting attendees and conversation previews', async () => {
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
        title: 'Executive slot',
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
        last_message_preview: null,
        updated_at: null,
        scholar: {
          user_id: 12,
          email: 'nameless@example.com',
          scholar_profile: null,
        },
        messages: [],
      },
    ]);

    const summary = await service.getGrantorDashboardSummary(4);

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
        title: 'Executive slot',
        attendee: 'Coordinator',
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
        last_message: 'No messages yet',
        last_message_at: undefined,
      },
    ]);
  });

  it('scopes its queries to the grantor verdict, disbursement, and executive pipelines', async () => {
    await service.getGrantorDashboardSummary(4);

    expect(prisma.application.findMany).toHaveBeenCalledWith(
      objectMatching({
        where: {
          stage: 'ENDORSED_TO_GRANTOR',
          scholar_profile: {
            user: { role: 'APPLICANT', is_active: true },
          },
        },
        orderBy: { stage_updated_at: 'desc' },
        take: 6,
      }),
    );
    expect(prisma.application.count).toHaveBeenCalledWith({
      where: {
        stage: { not: 'Draft' },
        scholar_profile: {
          user: { role: 'APPLICANT', is_active: true },
        },
      },
    });
    expect(prisma.gradeReport.findMany).toHaveBeenCalledWith(
      objectMatching({
        where: { appeal_status: 'PENDING_GRANTOR' },
        orderBy: { appeal_submitted_at: 'desc' },
        take: 6,
      }),
    );
    expect(prisma.disbursement.findMany).toHaveBeenNthCalledWith(
      1,
      objectMatching({
        where: { status: { in: ['PENDING', 'AUTHORIZED'] } },
        take: 6,
      }),
    );
    expect(prisma.disbursement.findMany).toHaveBeenNthCalledWith(
      2,
      objectMatching({
        orderBy: { disbursement_id: 'desc' },
        take: 6,
      }),
    );
    expect(prisma.meeting.findMany).toHaveBeenCalledWith(
      objectMatching({
        where: { meeting_date: { gte: anyArg(Date) } },
        take: 5,
      }),
    );
    expect(prisma.conversation.findMany).toHaveBeenCalledWith(
      objectMatching({ take: 5 }),
    );
  });
});
