import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ScholarBaselineService } from './scholar-baseline.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { SettingsService } from '../../settings/settings.service.js';
import { EventsGateway } from '../../events/events.gateway.js';
import { AppCacheService } from '../../common/cache/app-cache.service.js';
import { BatchUpdateSubjectsDto } from '../dto/batch-update-subjects.dto.js';

// Asymmetric matchers are untyped; cast once so nested properties satisfy the linter.
const anyArg = (ctor: unknown) => expect.any(ctor) as unknown;
const objectMatching = (shape: Record<string, unknown>) =>
  expect.objectContaining(shape) as Record<string, unknown>;

const createPrismaMock = () => ({
  scholarProfile: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  schoolGradingSystem: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
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
  termEnrollment: {
    findMany: vi.fn(),
    update: vi.fn(),
  },
  systemSetting: {
    findFirst: vi.fn(),
  },
  conversation: {
    findFirst: vi.fn(),
  },
  message: {
    count: vi.fn(),
  },
  forumPost: {
    findMany: vi.fn(),
  },
  academicChangeRequest: {
    findFirst: vi.fn(),
    findMany: vi.fn().mockResolvedValue([]),
  },
  scholarProspectusHistory: {
    findMany: vi.fn().mockResolvedValue([]),
  },
  scholarDocument: {
    findMany: vi.fn().mockResolvedValue([]),
  },
  gradeReport: {
    findMany: vi.fn().mockResolvedValue([]),
  },
});

const createAuditMock = () => ({ log: vi.fn() });
const createSettingsMock = () => ({ createSchoolGrading: vi.fn() });
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
  prerequisites: [],
  status: 'UNTAKEN',
  grade: null,
  credited_term: null,
  remarks: null,
  ...overrides,
});

const makeGradeReport = (overrides: Record<string, unknown> = {}) => ({
  report_id: 1,
  academic_year: '2025-2026',
  semester: '1st Semester',
  gpa: '1.75',
  status: 'APPROVED',
  evaluation_flag: null,
  appeal_status: null,
  appeal_notes: null,
  appeal_decision_notes: null,
  is_eligible: true,
  grade_items: [],
  submitted_at: new Date('2026-01-05T08:00:00.000Z'),
  ...overrides,
});

const makeScholar = (overrides: Record<string, unknown> = {}) => ({
  profile_id: 11,
  user_id: 7,
  first_name: 'Juan',
  last_name: 'Dela Cruz',
  phone_number: '09171234567',
  student_number: '2024-001',
  school_name: null,
  course_of_study: 'BSIT',
  current_year_level: 3,
  academic_baseline_status: 'PENDING_SCHOOL_SELECTION',
  avatar_url: 'https://cdn.test/avatar.png',
  banner_url: null,
  user: {
    user_id: 7,
    email: 'juan@example.com',
    role: 'SCHOLAR',
    is_active: true,
  },
  school_grading_system: {
    school_id: 1,
    school_name: 'University of Mindanao',
    grading_scale: 'NUMERIC_4_POINT',
  },
  prospectus: {
    prospectus_id: 60,
    scholar_profile_id: 11,
    total_units: 12,
    is_frozen: false,
    status: 'DRAFT',
    frozen_by_employee: null,
    document: { document_id: 50 },
    subjects: [
      makeSubject({ subject_id: 1, status: 'PASSED', grade: 2.0 }),
      makeSubject({ subject_id: 2, status: 'CREDITED', grade: 1.5 }),
      makeSubject({ subject_id: 3, status: 'UNTAKEN', grade: null }),
      makeSubject({ subject_id: 4, status: 'FAILED', grade: 5.0 }),
    ],
  },
  documents: [
    {
      document_id: 50,
      document_type: 'PROSPECTUS',
      uploaded_at: new Date('2026-01-01T08:00:00.000Z'),
    },
  ],
  grade_reports: [makeGradeReport()],
  enrollments: [
    {
      enrollment_id: 1,
      academic_year: '2025-2026',
      semester: '1st Semester',
      year_level: 3,
      status: 'ENROLLED',
      total_units: '12',
      total_assessment: '50000',
      enrolled_subjects: ['CCE101'],
      audit_flags: [],
      cor_document_id: null,
      soa_document_id: null,
      coordinator_notes: null,
      created_at: new Date('2026-01-02T08:00:00.000Z'),
    },
  ],
  disbursements: [
    {
      disbursement_id: 4,
      academic_year: '2025-2026',
      semester: '1st Semester',
      amount: '2000',
      status: 'SETTLED',
      date_issued: new Date('2026-01-03T08:00:00.000Z'),
      date_claimed: new Date('2026-01-04T08:00:00.000Z'),
      voucher_number: 'V-1',
      check_number: 'C-1',
      or_number: 'OR-1',
      or_document_id: 1,
    },
    {
      disbursement_id: 3,
      academic_year: '2025-2026',
      semester: '1st Semester',
      amount: '1000',
      status: 'CLAIMED',
      date_issued: null,
      date_claimed: null,
      or_document_id: null,
    },
    {
      disbursement_id: 2,
      academic_year: '2024-2025',
      semester: '2nd Semester',
      amount: '500',
      status: 'RELEASED',
      date_issued: null,
      date_claimed: null,
      or_document_id: null,
    },
    {
      disbursement_id: 1,
      academic_year: '2024-2025',
      semester: '1st Semester',
      amount: '999',
      status: 'PENDING',
      date_issued: null,
      date_claimed: null,
      or_document_id: null,
    },
  ],
  meetings: [
    {
      meeting_id: 1,
      title: 'Check-in',
      meeting_date: new Date('2026-12-01T10:00:00.000Z'),
      meeting_time: '10:00',
      meeting_link: 'https://meet.test/check-in',
      status: 'SCHEDULED',
      employee: {
        first_name: 'Maria',
        last_name: 'Santos',
        title: 'Coordinator',
      },
    },
    {
      meeting_id: 2,
      title: 'Follow-up',
      meeting_date: new Date('2026-12-02T10:00:00.000Z'),
      meeting_time: '11:00',
      meeting_link: null,
      status: 'SCHEDULED',
      employee: null,
    },
  ],
  ...overrides,
});

const makeConversation = () => ({
  conversation_id: 9,
  scholar_user_id: 7,
  coordinator: {
    employee: {
      first_name: 'Maria',
      last_name: 'Santos',
      title: null,
    },
  },
  messages: [
    {
      message_id: 1,
      sender_user_id: 2,
      message_text: 'Please upload your prospectus.',
      message_type: 'TEXT',
      sent_at: new Date('2026-01-02T03:00:00.000Z'),
      is_read: false,
    },
  ],
});

const makeAnnouncement = () => ({
  post_id: 1,
  title: 'Enrollment Reminder',
  content: 'Submit your documents.',
  category: 'ANNOUNCEMENT',
  is_pinned: true,
  created_at: new Date('2026-01-01T00:00:00.000Z'),
  author: {
    email: 'staff@example.com',
    role: 'COORDINATOR',
    employee: null,
  },
});

const makeSubjectsDto = () =>
  ({
    course_name: 'BSIT',
    course_code: '',
    curriculum_year: '2024',
    subjects: [
      {
        subject_id: 5,
        subject_code: ' cce 101 ',
        descriptive_title: ' Intro ',
        units: 3,
        year_level: 1,
        semester: '1st Semester',
      },
      {
        subject_code: ' ge 1 ',
        descriptive_title: ' General Education ',
        units: 3,
        year_level: 1,
        semester: '1st Semester',
        status: 'FAILED',
        grade: 2,
        credited_term: '1st Year - 1st Semester',
        remarks: 'Transcript match',
      },
      {
        subject_code: ' pe 1 ',
        descriptive_title: ' Physical Education ',
        units: 2,
        year_level: 1,
        semester: '2nd Semester',
      },
    ],
  }) as BatchUpdateSubjectsDto;

describe('ScholarBaselineService', () => {
  let service: ScholarBaselineService;
  let prisma: ReturnType<typeof createPrismaMock>;
  let audit: ReturnType<typeof createAuditMock>;
  let settings: ReturnType<typeof createSettingsMock>;
  let events: ReturnType<typeof createEventsMock>;
  let cache: ReturnType<typeof createCacheMock>;

  beforeEach(async () => {
    prisma = createPrismaMock();
    audit = createAuditMock();
    settings = createSettingsMock();
    events = createEventsMock();
    cache = createCacheMock();

    cache.wrap.mockImplementation(
      async (_key: string, factory: () => Promise<unknown>) => factory(),
    );

    prisma.scholarProfile.findUnique.mockResolvedValue(makeScholar());
    prisma.scholarProfile.update.mockResolvedValue({
      profile_id: 11,
      academic_baseline_status: 'PENDING_PROSPECTUS',
      school_grading_system: {
        school_id: 1,
        school_name: 'University of Mindanao',
      },
    });
    prisma.schoolGradingSystem.findUnique.mockResolvedValue({
      school_id: 1,
      school_name: 'University of Mindanao',
    });
    prisma.schoolGradingSystem.findMany.mockResolvedValue([]);
    prisma.scholarProspectus.findUnique.mockResolvedValue({
      prospectus_id: 60,
      scholar_profile_id: 11,
      subjects: [],
    });
    prisma.scholarProspectus.update.mockResolvedValue({ prospectus_id: 60 });
    prisma.prospectusSubject.update.mockResolvedValue({ subject_id: 5 });
    prisma.prospectusSubject.create.mockResolvedValue({ subject_id: 6 });
    prisma.systemSetting.findFirst.mockResolvedValue({ grade_threshold: '90' });
    prisma.conversation.findFirst.mockResolvedValue(makeConversation());
    prisma.message.count.mockResolvedValue(4);
    prisma.forumPost.findMany.mockResolvedValue([makeAnnouncement()]);
    settings.createSchoolGrading.mockResolvedValue({
      school_id: 3,
      school_name: 'New College',
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ScholarBaselineService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: SettingsService, useValue: settings },
        { provide: EventsGateway, useValue: events },
        { provide: AppCacheService, useValue: cache },
      ],
    }).compile();

    service = module.get<ScholarBaselineService>(ScholarBaselineService);
  });

  it('is created by the Nest testing module', () => {
    expect(service).toBeDefined();
  });

  describe('getScholarBaselineState', () => {
    it('caches the onboarding state for one hour and honors refresh', async () => {
      const result = await service.getScholarBaselineState(7, true);

      expect(cache.wrap).toHaveBeenCalledWith(
        'baseline:scholar:7',
        anyArg(Function),
        60 * 60 * 1000,
        true,
      );
      expect(prisma.scholarProfile.findUnique).toHaveBeenCalledWith(
        objectMatching({ where: { user_id: 7 } }),
      );
      expect(result.profile_id).toBe(11);
      expect(result.student_name).toBe('Juan Dela Cruz');
      expect(result.documents).toHaveLength(1);
    });

    it('computes credited and remaining unit metrics', async () => {
      const result = await service.getScholarBaselineState(7);

      expect(result.metrics).toEqual({
        total_subjects: 4,
        total_units: 12,
        credited_subjects: 2,
        credited_units: 6,
        untaken_subjects: 2,
        remaining_units: 6,
        is_baseline_frozen: false,
      });
    });

    it('returns zeroed metrics when the scholar has no prospectus', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue(
        makeScholar({ prospectus: null }),
      );

      const result = await service.getScholarBaselineState(7);

      expect(result.prospectus).toBeNull();
      expect(result.metrics).toEqual({
        total_subjects: 0,
        total_units: 0,
        credited_subjects: 0,
        credited_units: 0,
        untaken_subjects: 0,
        remaining_units: 0,
        is_baseline_frozen: false,
      });
    });

    it('throws NotFoundException when the scholar profile is missing', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue(null);

      await expect(service.getScholarBaselineState(7)).rejects.toThrow(
        new NotFoundException('Scholar profile not found.'),
      );
    });
  });

  describe('selectOrProposeSchool', () => {
    it('throws NotFoundException when the scholar profile is missing', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue(null);

      await expect(
        service.selectOrProposeSchool(7, { school_id: 1 }),
      ).rejects.toThrow('Scholar profile not found.');
    });

    it('requires either an existing school or a proposed school name', async () => {
      await expect(service.selectOrProposeSchool(7, {})).rejects.toThrow(
        'Either school_id or new_school_name must be provided.',
      );
    });

    it('selects an existing school and advances the baseline status', async () => {
      const result = await service.selectOrProposeSchool(7, { school_id: 1 });

      expect(prisma.schoolGradingSystem.findUnique).toHaveBeenCalledWith({
        where: { school_id: 1 },
      });
      expect(prisma.scholarProfile.update).toHaveBeenCalledWith({
        where: { profile_id: 11 },
        data: {
          school_id: 1,
          academic_baseline_status: 'PENDING_PROSPECTUS',
        },
        include: { school_grading_system: true },
      });
      expect(audit.log).toHaveBeenCalledWith(
        7,
        'BASELINE_SCHOOL_SELECTED',
        expect.stringContaining('University of Mindanao'),
      );
      expect(events.emitToUser).toHaveBeenCalledWith(
        7,
        'baseline:school_selected',
        {
          school_id: 1,
          school_name: 'University of Mindanao',
          academic_baseline_status: 'PENDING_PROSPECTUS',
        },
      );
      expect(cache.del).toHaveBeenCalledWith('baseline:scholar:7');
      expect(cache.del).toHaveBeenCalledWith('baseline:review:11');
      expect(cache.del).toHaveBeenCalledWith('dashboard:scholar:7');
      expect(result.message).toBe(
        'Institution grading configuration confirmed.',
      );
      expect(result.scholar_profile.school_grading_system!.school_name).toBe(
        'University of Mindanao',
      );
    });

    it('preserves an advanced baseline status when selecting a school', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue(
        makeScholar({ academic_baseline_status: 'BASELINE_FROZEN' }),
      );
      prisma.scholarProfile.update.mockResolvedValue({
        profile_id: 11,
        academic_baseline_status: 'BASELINE_FROZEN',
        school_grading_system: { school_id: 1 },
      });

      await service.selectOrProposeSchool(7, { school_id: 1 });

      expect(prisma.scholarProfile.update).toHaveBeenCalledWith(
        objectMatching({
          data: {
            school_id: 1,
            academic_baseline_status: 'BASELINE_FROZEN',
          },
        }),
      );
    });

    it('throws NotFoundException when the selected school does not exist', async () => {
      prisma.schoolGradingSystem.findUnique.mockResolvedValue(null);

      await expect(
        service.selectOrProposeSchool(7, { school_id: 999 }),
      ).rejects.toThrow('School grading ID 999 not found.');
    });

    it('reuses an existing school matched by normalized name', async () => {
      prisma.schoolGradingSystem.findMany.mockResolvedValue([
        { school_id: 2, school_name: 'University of Mindanao' },
      ]);
      prisma.scholarProfile.update.mockResolvedValue({
        profile_id: 11,
        academic_baseline_status: 'PENDING_PROSPECTUS',
        school_grading_system: {
          school_id: 2,
          school_name: 'University of Mindanao',
        },
      });

      await service.selectOrProposeSchool(7, {
        new_school_name: 'University of Mindanao (UM)',
      });

      expect(settings.createSchoolGrading).not.toHaveBeenCalled();
      expect(prisma.scholarProfile.update).toHaveBeenCalledWith(
        objectMatching({
          data: objectMatching({ school_id: 2 }),
        }),
      );
    });

    it('proposes a new school with default grading values', async () => {
      prisma.schoolGradingSystem.findMany.mockResolvedValue([
        { school_id: 2, school_name: 'Another University' },
      ]);
      prisma.scholarProfile.update.mockResolvedValue({
        profile_id: 11,
        academic_baseline_status: 'PENDING_SCHOOL_SELECTION',
        school_grading_system: { school_id: 3, school_name: 'New College' },
      });

      const result = await service.selectOrProposeSchool(7, {
        new_school_name: '  New College  ',
        special_codes: { '9.0': 'DROPPED' },
        notes: 'Proposed by scholar',
      });

      expect(settings.createSchoolGrading).toHaveBeenCalledWith(
        7,
        {
          school_name: 'New College',
          grading_scale: 'NUMERIC_4_POINT',
          passing_grade: 2.0,
          highest_grade: 4.0,
          failing_grade: 1.0,
          min_grade: 1.0,
          max_grade: 4.0,
          special_codes: { '9.0': 'DROPPED' },
          notes: 'Proposed by scholar',
          is_verified: false,
        },
        'SCHOLAR',
      );
      expect(prisma.scholarProfile.update).toHaveBeenCalledWith(
        objectMatching({
          data: objectMatching({ school_id: 3 }),
        }),
      );
      expect(result.scholar_profile.school_grading_system!.school_name).toBe(
        'New College',
      );
    });

    it('passes explicit grading configuration when proposing a school', async () => {
      prisma.scholarProfile.update.mockResolvedValue({
        profile_id: 11,
        academic_baseline_status: 'PENDING_PROSPECTUS',
        school_grading_system: { school_id: 3, school_name: 'State College' },
      });

      await service.selectOrProposeSchool(7, {
        new_school_name: 'State College',
        grading_scale: 'PERCENTAGE_100',
        passing_grade: 75,
        highest_grade: 100,
        failing_grade: 50,
        min_grade: 0,
        max_grade: 100,
      });

      expect(settings.createSchoolGrading).toHaveBeenCalledWith(
        7,
        objectMatching({
          grading_scale: 'PERCENTAGE_100',
          passing_grade: 75,
          highest_grade: 100,
          failing_grade: 50,
          min_grade: 0,
          max_grade: 100,
        }),
        'SCHOLAR',
      );
    });
  });

  describe('updateProspectusSubjects', () => {
    it('rejects staff callers and directs them to the coordinator endpoint', async () => {
      await expect(
        service.updateProspectusSubjects(7, makeSubjectsDto(), true),
      ).rejects.toThrow('Staff should use coordinatorUpdateSubjects endpoint.');
      expect(prisma.scholarProfile.findUnique).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when the scholar profile is missing', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue(null);

      await expect(
        service.updateProspectusSubjects(7, makeSubjectsDto()),
      ).rejects.toThrow('Scholar profile not found.');
    });

    it('forbids edits to a frozen baseline', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue(
        makeScholar({ prospectus: { prospectus_id: 60, is_frozen: true } }),
      );

      await expect(
        service.updateProspectusSubjects(7, makeSubjectsDto()),
      ).rejects.toThrow(ForbiddenException);
    });

    it('throws NotFoundException when the prospectus does not exist', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue(
        makeScholar({ prospectus: null }),
      );
      prisma.scholarProspectus.findUnique.mockResolvedValue(null);

      await expect(
        service.updateProspectusSubjects(7, makeSubjectsDto()),
      ).rejects.toThrow(
        'Scholar prospectus record not found. Please upload a prospectus first.',
      );
    });

    it('updates the header and upserts existing and new subjects', async () => {
      const refreshed = { prospectus_id: 60, subjects: [] };
      prisma.scholarProspectus.findUnique
        .mockResolvedValueOnce({ prospectus_id: 60 })
        .mockResolvedValueOnce(refreshed);

      const result = await service.updateProspectusSubjects(
        7,
        makeSubjectsDto(),
      );

      expect(prisma.scholarProspectus.update).toHaveBeenCalledWith({
        where: { prospectus_id: 60 },
        data: {
          course_name: 'BSIT',
          course_code: undefined,
          curriculum_year: '2024',
        },
      });

      expect(prisma.prospectusSubject.update).toHaveBeenCalledWith({
        where: { subject_id: 5 },
        data: {
          subject_code: 'CCE 101',
          descriptive_title: 'Intro',
          units: 3,
          year_level: 1,
          semester: '1st Semester',
          prerequisites: [],
          status: undefined,
          grade: undefined,
          credited_term: undefined,
          remarks: undefined,
        },
      });

      expect(prisma.prospectusSubject.create).toHaveBeenNthCalledWith(1, {
        data: {
          prospectus_id: 60,
          subject_code: 'GE 1',
          descriptive_title: 'General Education',
          units: 3,
          year_level: 1,
          semester: '1st Semester',
          prerequisites: [],
          status: 'FAILED',
          grade: 2,
          credited_term: '1st Year - 1st Semester',
          remarks: 'Transcript match',
        },
      });
      expect(prisma.prospectusSubject.create).toHaveBeenNthCalledWith(2, {
        data: objectMatching({
          subject_code: 'PE 1',
          status: 'UNTAKEN',
          grade: undefined,
          credited_term: undefined,
          remarks: undefined,
        }),
      });

      expect(audit.log).toHaveBeenCalledWith(
        7,
        'BASELINE_SUBJECTS_UPDATED',
        'Updated 3 subjects on prospectus ID 60.',
      );
      expect(cache.del).toHaveBeenCalledWith('baseline:scholar:7');
      expect(cache.del).toHaveBeenCalledWith('baseline:review:11');
      expect(cache.del).toHaveBeenCalledWith('dashboard:scholar:7');
      expect(result).toEqual({
        message: 'Prospectus subjects saved successfully.',
        prospectus: refreshed,
      });
    });
  });

  describe('submitForReview', () => {
    it('throws NotFoundException when the scholar profile is missing', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue(null);

      await expect(service.submitForReview(7)).rejects.toThrow(
        'Scholar profile not found.',
      );
    });

    it('requires a prospectus before submission', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue(
        makeScholar({ prospectus: null }),
      );

      await expect(service.submitForReview(7)).rejects.toThrow(
        'Please upload your prospectus before submitting for review.',
      );
    });

    it('requires at least one prospectus subject before submission', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue(
        makeScholar({
          prospectus: { prospectus_id: 60, subjects: [] },
        }),
      );

      await expect(service.submitForReview(7)).rejects.toThrow(
        'No subjects found on prospectus checklist.',
      );
    });

    it('marks the baseline and prospectus pending review and notifies staff', async () => {
      prisma.scholarProfile.update.mockResolvedValue({
        profile_id: 11,
        academic_baseline_status: 'PENDING_COORDINATOR_REVIEW',
      });

      const result = await service.submitForReview(7);

      expect(prisma.scholarProfile.update).toHaveBeenCalledWith({
        where: { profile_id: 11 },
        data: { academic_baseline_status: 'PENDING_COORDINATOR_REVIEW' },
      });
      expect(prisma.scholarProspectus.update).toHaveBeenCalledWith({
        where: { prospectus_id: 60 },
        data: { status: 'PENDING_REVIEW' },
      });
      expect(audit.log).toHaveBeenCalledWith(
        7,
        'BASELINE_SUBMITTED_FOR_REVIEW',
        'Scholar Juan Dela Cruz submitted academic baseline for coordinator freeze review.',
      );

      const eventPayload = {
        scholarProfileId: 11,
        studentName: 'Juan Dela Cruz',
        courseOfStudy: 'BSIT',
        schoolName: null,
        subjectsCount: 4,
        submittedAt: anyArg(String),
      };
      expect(events.emitToStaff).toHaveBeenCalledWith(
        'baseline:submitted_for_review',
        eventPayload,
      );
      expect(events.emitToUser).toHaveBeenCalledWith(
        7,
        'baseline:submitted_for_review',
        eventPayload,
      );

      expect(cache.del).toHaveBeenCalledWith('baseline:scholar:7');
      expect(cache.del).toHaveBeenCalledWith('baseline:review:11');
      expect(cache.del).toHaveBeenCalledWith('dashboard:scholar:7');
      expect(cache.delPattern).toHaveBeenCalledWith('dashboard:coordinator:');
      expect(cache.delPattern).toHaveBeenCalledWith('dashboard:grantor:');
      expect(result).toEqual({
        message: 'Academic baseline submitted for coordinator review.',
        academic_baseline_status: 'PENDING_COORDINATOR_REVIEW',
      });
    });

    it('blocks submitting the old prospectus during PENDING_SHIFT_PROSPECTUS when uploaded before shift approval', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue(
        makeScholar({
          academic_baseline_status: 'PENDING_SHIFT_PROSPECTUS',
          prospectus: {
            prospectus_id: 60,
            is_frozen: false,
            status: 'DRAFT',
            document: {
              document_id: 50,
              uploaded_at: new Date('2026-01-01T08:00:00.000Z'),
            },
            subjects: [makeSubject()],
          },
        }),
      );
      prisma.academicChangeRequest.findFirst.mockResolvedValue({
        request_id: 1,
        status: 'APPROVED',
        reviewed_at: new Date('2026-02-01T08:00:00.000Z'),
      });

      await expect(service.submitForReview(7)).rejects.toThrow(
        /You have not uploaded a new prospectus yet/i,
      );
      expect(prisma.scholarProfile.update).not.toHaveBeenCalled();
      expect(prisma.scholarProspectus.update).not.toHaveBeenCalled();
    });

    it('allows submitting once a new prospectus is uploaded after shift approval', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue(
        makeScholar({
          academic_baseline_status: 'PENDING_SHIFT_PROSPECTUS',
          prospectus: {
            prospectus_id: 61,
            is_frozen: false,
            status: 'DRAFT',
            document: {
              document_id: 51,
              uploaded_at: new Date('2026-02-02T08:00:00.000Z'),
            },
            subjects: [makeSubject()],
          },
        }),
      );
      prisma.academicChangeRequest.findFirst.mockResolvedValue({
        request_id: 1,
        status: 'APPROVED',
        reviewed_at: new Date('2026-02-01T08:00:00.000Z'),
      });
      prisma.scholarProfile.update.mockResolvedValue({
        profile_id: 11,
        academic_baseline_status: 'PENDING_COORDINATOR_REVIEW',
      });

      const result = await service.submitForReview(7);

      expect(result.academic_baseline_status).toBe('PENDING_COORDINATOR_REVIEW');
      expect(prisma.scholarProspectus.update).toHaveBeenCalledWith({
        where: { prospectus_id: 61 },
        data: { status: 'PENDING_REVIEW' },
      });
    });

    it('heals an accidentally submitted old prospectus back to PENDING_SHIFT_PROSPECTUS in getScholarBaselineState', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue(
        makeScholar({
          academic_baseline_status: 'PENDING_COORDINATOR_REVIEW',
          prospectus: {
            prospectus_id: 60,
            is_frozen: false,
            status: 'PENDING_REVIEW',
            document: {
              document_id: 50,
              uploaded_at: new Date('2026-01-01T08:00:00.000Z'),
            },
            subjects: [makeSubject()],
          },
        }),
      );
      prisma.academicChangeRequest.findFirst.mockResolvedValue({
        request_id: 1,
        status: 'APPROVED',
        reviewed_at: new Date('2026-02-01T08:00:00.000Z'),
      });

      const state = await service.getScholarBaselineState(7, true);

      expect(state.academic_baseline_status).toBe('PENDING_SHIFT_PROSPECTUS');
      expect(prisma.scholarProfile.update).toHaveBeenCalledWith({
        where: { profile_id: 11 },
        data: { academic_baseline_status: 'PENDING_SHIFT_PROSPECTUS' },
      });
      expect(prisma.scholarProspectus.update).toHaveBeenCalledWith({
        where: { prospectus_id: 60 },
        data: { status: 'DRAFT' },
      });
    });

    it('prunes leftover pre-shift 1st-semester subjects and skips pre-shift enrollments after post-shift upload', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue(
        makeScholar({
          academic_baseline_status: 'PENDING_SHIFT_PROSPECTUS',
          prospectus: {
            prospectus_id: 61,
            is_frozen: false,
            status: 'DRAFT',
            document: {
              document_id: 51,
              uploaded_at: new Date('2026-02-02T08:00:00.000Z'),
            },
            subjects: [
              makeSubject({
                subject_id: 10,
                subject_code: 'OLD101',
                status: 'PASSED',
                grade: 1.5,
                units: 3,
                created_at: new Date('2026-01-01T08:00:00.000Z'),
              }),
              makeSubject({
                subject_id: 11,
                subject_code: 'GE1',
                status: 'UNTAKEN',
                grade: null,
                units: 3,
                created_at: new Date('2026-02-02T08:00:01.000Z'),
              }),
            ],
          },
        }),
      );
      prisma.academicChangeRequest.findFirst.mockResolvedValue({
        request_id: 1,
        status: 'APPROVED',
        reviewed_at: new Date('2026-02-01T08:00:00.000Z'),
      });
      prisma.termEnrollment.findMany.mockResolvedValue([
        {
          enrollment_id: 99,
          academic_year: '2025-2026',
          semester: '1st Semester',
          status: 'APPROVED',
          created_at: new Date('2026-01-10T08:00:00.000Z'),
          enrolled_subjects: [{ subject_code: 'GE1' }],
        },
      ]);

      const state = await service.getScholarBaselineState(7, true);

      expect(prisma.prospectusSubject.deleteMany).toHaveBeenCalledWith({
        where: { subject_id: { in: [10] } },
      });
      expect(state.prospectus?.subjects).toHaveLength(1);
      expect(state.prospectus?.subjects[0].subject_code).toBe('GE1');
      expect(state.prospectus?.subjects[0].status).toBe('UNTAKEN');
      expect(prisma.prospectusSubject.update).not.toHaveBeenCalled();
    });
  });

  describe('getScholarProspectusHistory', () => {
    it('returns archived prospectus snapshots and reconstructs unarchived pre-shift history with grade reports', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue({
        profile_id: 11,
        course_of_study: 'BSIT',
        school_name: 'University of Mindanao',
        academic_baseline_status: 'PENDING_COORDINATOR_REVIEW',
      });
      prisma.scholarProspectusHistory.findMany.mockResolvedValue([
        {
          history_id: 5,
          scholar_profile_id: 11,
          academic_change_request_id: 2,
          document_id: 51,
          curriculum_year: '2024-2025',
          course_code: 'BSCE',
          course_name: 'BS Civil Engineering',
          school_name: 'University of Mindanao',
          total_units: 6,
          credited_units: 3,
          status: 'FROZEN',
          archive_reason: 'PROGRAM_SHIFT',
          is_frozen: true,
          frozen_at: new Date('2026-01-15T08:00:00.000Z'),
          archived_at: new Date('2026-03-01T08:00:00.000Z'),
          subjects_snapshot: [
            {
              subject_code: 'CE101',
              descriptive_title: 'Engineering Drawing',
              units: 3,
              year_level: 1,
              semester: '1st Semester',
              status: 'PASSED',
              grade: 1.5,
              credited_term: '2025-2026 1st Semester',
              remarks: null,
              prerequisites: null,
            },
          ],
          document: {
            document_id: 51,
            file_name: 'ce-prospectus.pdf',
            file_url: 'https://cdn.test/ce.pdf',
            file_type: 'pdf',
            uploaded_at: new Date('2026-01-05T08:00:00.000Z'),
          },
          academic_change_request: null,
        },
      ]);
      prisma.academicChangeRequest.findMany.mockResolvedValue([
        {
          request_id: 1,
          change_type: 'PROGRAM_SHIFT',
          current_course_of_study: 'BS Accountancy',
          current_school_name: 'University of Mindanao',
          requested_course_of_study: 'BS Civil Engineering',
          requested_school_name: null,
          effective_academic_year: '2025-2026',
          effective_semester: '2nd Semester',
          reviewed_at: new Date('2026-01-01T08:00:00.000Z'),
          created_at: new Date('2025-12-20T08:00:00.000Z'),
        },
      ]);
      prisma.scholarDocument.findMany.mockResolvedValue([
        {
          document_id: 40,
          file_name: 'bsa-prospectus.pdf',
          file_url: 'https://cdn.test/bsa.pdf',
          file_type: 'pdf',
          uploaded_at: new Date('2025-08-01T08:00:00.000Z'),
          extracted_data: {
            curriculum_year: '2023-2024',
            course_code: 'BSA',
            total_units: 3,
            subjects: [
              {
                subject_code: 'ACC101',
                descriptive_title: 'Financial Accounting',
                units: 3,
                year_level: 1,
                semester: '1st Semester',
                status: 'UNTAKEN',
              },
            ],
          },
        },
      ]);
      prisma.gradeReport.findMany.mockResolvedValue([
        {
          academic_year: '2025-2026',
          semester: '1st Semester',
          submitted_at: new Date('2025-12-10T08:00:00.000Z'),
          grade_items: [
            { subject_code: 'ACC101', grade: 1.75, raw_status: 'PASSED' },
          ],
        },
      ]);

      const result = await service.getScholarProspectusHistory(7);

      expect(result.current_program.course_of_study).toBe('BSIT');
      expect(result.history).toHaveLength(2);
      expect(result.history[0].course_name).toBe('BS Civil Engineering');
      expect(result.history[0].source).toBe('ARCHIVED_SNAPSHOT');
      expect(result.history[1].course_name).toBe('BS Accountancy');
      expect(result.history[1].source).toBe('RECONSTRUCTED_PRE_SHIFT');
      expect(result.history[1].subjects[0].grade).toBe(1.75);
      expect(result.history[1].subjects[0].status).toBe('PASSED');
    });
  });

  describe('getScholarDashboardSummary', () => {
    const loadDashboard = async (
      overrides: Record<string, unknown> = {},
      options: {
        setting?: Record<string, unknown> | null;
        conversation?: Record<string, unknown> | null;
        unread?: number;
        announcements?: Record<string, unknown>[];
      } = {},
    ) => {
      prisma.scholarProfile.findUnique.mockResolvedValue(
        makeScholar(overrides),
      );
      prisma.systemSetting.findFirst.mockResolvedValue(
        options.setting === undefined
          ? { grade_threshold: '88.5' }
          : options.setting,
      );
      prisma.conversation.findFirst.mockResolvedValue(
        options.conversation === undefined
          ? makeConversation()
          : options.conversation,
      );
      prisma.message.count.mockResolvedValue(options.unread ?? 4);
      prisma.forumPost.findMany.mockResolvedValue(
        options.announcements ?? [makeAnnouncement()],
      );

      return service.getScholarDashboardSummary(7);
    };

    it('caches the dashboard summary for one minute and honors refresh', async () => {
      await loadDashboard(
        { academic_baseline_status: 'PENDING_COORDINATOR_REVIEW' },
        {},
      );
      await service.getScholarDashboardSummary(7, true);

      expect(cache.wrap).toHaveBeenNthCalledWith(
        1,
        'dashboard:scholar:7',
        anyArg(Function),
        60 * 1000,
        false,
      );
      expect(cache.wrap).toHaveBeenNthCalledWith(
        2,
        'dashboard:scholar:7',
        anyArg(Function),
        60 * 1000,
        true,
      );
    });

    it('aggregates curriculum, standing, finance, and communication data', async () => {
      const result = await loadDashboard(
        { academic_baseline_status: 'PENDING_COORDINATOR_REVIEW' },
        {},
      );

      expect(result.profile).toEqual({
        profile_id: 11,
        user_id: 7,
        first_name: 'Juan',
        last_name: 'Dela Cruz',
        email: 'juan@example.com',
        phone_number: '09171234567',
        student_number: '2024-001',
        school_name: 'University of Mindanao',
        course_of_study: 'BSIT',
        current_year_level: 3,
        academic_baseline_status: 'PENDING_COORDINATOR_REVIEW',
        archived_at: null,
        archive_reason: null,
        archive_notes: null,
        avatar_url: 'https://cdn.test/avatar.png',
        banner_url: null,
      });

      expect(result.academic_standing).toMatchObject({
        standing_type: 'GOOD_STANDING',
        gwa: 1.75,
        threshold: 88.5,
        is_on_probation: false,
        is_flagged: false,
        has_pending_appeal: false,
        latest_report: {
          report_id: 1,
          academic_year: '2025-2026',
          gpa: 1.75,
          status: 'APPROVED',
        },
      });

      expect(result.curriculum).toEqual({
        total_units: 12,
        passed_units: 6,
        percentage: 50,
        total_subjects: 4,
        passed_subjects_count: 2,
        is_frozen: false,
        prospectus_status: 'DRAFT',
      });

      expect(result.latest_enrollment).toMatchObject({
        enrollment_id: 1,
        total_units: 12,
        total_assessment: 50000,
      });

      expect(result.disbursements.latest).toMatchObject({
        disbursement_id: 4,
        amount: 2000,
        status: 'SETTLED',
      });
      expect(result.disbursements.history).toHaveLength(4);
      expect(result.disbursements.total_disbursed_amount).toBe(3500);
      expect(result.disbursements.pending_or_count).toBe(2);

      expect(result.communication.unread_messages_count).toBe(4);
      expect(result.communication.coordinator).toEqual({
        name: 'Maria Santos',
        title: 'Scholarship Coordinator',
      });
      expect(result.communication.recent_messages).toEqual([
        {
          message_id: 1,
          sender_user_id: 2,
          message_text: 'Please upload your prospectus.',
          message_type: 'TEXT',
          sent_at: new Date('2026-01-02T03:00:00.000Z'),
          is_read: false,
        },
      ]);

      expect(result.upcoming_meetings).toHaveLength(2);
      expect(result.upcoming_meetings[0].coordinator_name).toBe('Maria Santos');
      expect(result.upcoming_meetings[1].coordinator_name).toBe('Coordinator');
      expect(result.announcements).toEqual([
        objectMatching({
          post_id: 1,
          author_name: 'ViaScholar Staff',
        }),
      ]);

      expect(prisma.message.count).toHaveBeenCalledWith({
        where: {
          conversation_id: 9,
          sender_user_id: { not: 7 },
          is_read: false,
        },
      });
    });

    it('falls back to weighted prospectus grades without a grade report', async () => {
      const result = await loadDashboard({
        academic_baseline_status: 'PENDING_COORDINATOR_REVIEW',
        grade_reports: [],
        prospectus: {
          prospectus_id: 60,
          total_units: 12,
          is_frozen: false,
          status: 'DRAFT',
          subjects: [
            makeSubject({ status: 'PASSED', units: 3, grade: 2.0 }),
            makeSubject({ status: 'CREDITED', units: 3, grade: 1.5 }),
            makeSubject({ status: 'UNTAKEN', units: 3, grade: null }),
          ],
        },
      });

      expect(result.academic_standing.gwa).toBe(1.75);
      expect(result.academic_standing.latest_report).toBeNull();
      expect(result.academic_standing.standing_type).toBe('GOOD_STANDING');
    });

    it('uses the configured threshold when passed subjects have no grades', async () => {
      const result = await loadDashboard(
        {
          academic_baseline_status: 'PENDING_COORDINATOR_REVIEW',
          grade_reports: [],
          prospectus: {
            prospectus_id: 60,
            total_units: 12,
            is_frozen: false,
            status: 'DRAFT',
            subjects: [
              makeSubject({ status: 'PASSED', units: 3, grade: null }),
              makeSubject({ status: 'CREDITED', units: 3, grade: null }),
            ],
          },
        },
        { setting: { grade_threshold: '87' } },
      );

      expect(result.academic_standing.gwa).toBe(87);
      expect(result.academic_standing.threshold).toBe(87);
    });

    it('defaults to a 90 threshold when no grades or settings exist', async () => {
      const result = await loadDashboard(
        {
          academic_baseline_status: 'PENDING_PROSPECTUS',
          current_year_level: null,
          school_name: null,
          school_grading_system: null,
          prospectus: null,
          grade_reports: [],
          enrollments: [],
          disbursements: [],
          documents: [],
          meetings: [],
        },
        {
          setting: null,
          conversation: null,
          unread: 0,
          announcements: [],
        },
      );

      expect(result.academic_standing.gwa).toBe(90);
      expect(result.academic_standing.threshold).toBe(90);
      expect(result.profile.current_year_level).toBe(1);
      expect(result.profile.school_name).toBeUndefined();
      expect(result.curriculum).toEqual({
        total_units: 0,
        passed_units: 0,
        percentage: 0,
        total_subjects: 0,
        passed_subjects_count: 0,
        is_frozen: false,
        prospectus_status: 'DRAFT',
      });
      expect(result.latest_enrollment).toBeNull();
      expect(result.disbursements.latest).toBeNull();
      expect(result.disbursements.total_disbursed_amount).toBe(0);
      expect(result.disbursements.pending_or_count).toBe(0);
      expect(result.communication.unread_messages_count).toBe(0);
      expect(result.communication.coordinator).toBeNull();
      expect(result.communication.recent_messages).toEqual([]);
      expect(result.upcoming_meetings).toEqual([]);
      expect(result.announcements).toEqual([]);
      expect(prisma.message.count).not.toHaveBeenCalled();
    });

    it('marks probation when the scholar is on probation', async () => {
      const result = await loadDashboard({
        academic_baseline_status: 'ON_PROBATION',
      });

      expect(result.academic_standing.standing_type).toBe('PROBATION');
      expect(result.academic_standing.is_on_probation).toBe(true);
    });

    it('treats an approved appeal as probation', async () => {
      const result = await loadDashboard({
        academic_baseline_status: 'PENDING_COORDINATOR_REVIEW',
        grade_reports: [makeGradeReport({ appeal_status: 'APPROVED' })],
      });

      expect(result.academic_standing.standing_type).toBe('PROBATION');
      expect(result.academic_standing.is_on_probation).toBe(true);
    });

    it('marks a pending grantor appeal as pending review', async () => {
      const result = await loadDashboard({
        academic_baseline_status: 'PENDING_COORDINATOR_REVIEW',
        grade_reports: [makeGradeReport({ appeal_status: 'PENDING_GRANTOR' })],
      });

      expect(result.academic_standing.standing_type).toBe('PENDING_REVIEW');
      expect(result.academic_standing.has_pending_appeal).toBe(true);
    });

    it('marks a denied appeal as discontinued and includes grantor/coordinator contact info', async () => {
      const result = await loadDashboard({
        academic_baseline_status: 'DISCONTINUED',
        archived_at: new Date('2026-06-01T00:00:00.000Z'),
        archive_reason: 'FAILED_SECOND_CHANCE',
        grade_reports: [
          makeGradeReport({
            appeal_status: 'DENIED',
            appeal_decision_notes: 'Insufficient evidence',
          }),
        ],
      });

      expect(result.academic_standing.standing_type).toBe('DISCONTINUED');
      expect(result.academic_standing.is_discontinued).toBe(true);
      expect(result.academic_standing.latest_report).toMatchObject({
        appeal_status: 'DENIED',
        appeal_decision_notes: 'Insufficient evidence',
      });
    });

    it('self-heals an unarchived 2nd-probation failure into DISCONTINUED standing', async () => {
      const result = await loadDashboard({
        academic_baseline_status: 'ON_PROBATION',
        grade_reports: [
          makeGradeReport({
            report_id: 2,
            academic_year: '2024',
            semester: 'Summer',
            gpa: '3.00',
            status: 'FLAGGED',
            is_eligible: false,
            appeal_status: 'NONE',
          }),
          makeGradeReport({
            report_id: 1,
            academic_year: '2023-2024',
            semester: '1st Semester',
            gpa: '2.95',
            status: 'FLAGGED',
            is_eligible: false,
            appeal_status: 'APPROVED',
          }),
        ],
      });

      expect(result.academic_standing.standing_type).toBe('DISCONTINUED');
      expect(result.academic_standing.second_chance_exhausted).toBe(true);
      expect(result.profile.archive_reason).toBe('FAILED_SECOND_CHANCE');
      expect(prisma.scholarProfile.update).toHaveBeenCalledWith({
        where: { profile_id: 11 },
        data: objectMatching({
          academic_baseline_status: 'DISCONTINUED',
          archive_reason: 'FAILED_SECOND_CHANCE',
        }),
      });
    });

    it('marks a flagged report as action required', async () => {
      const result = await loadDashboard({
        academic_baseline_status: 'PENDING_COORDINATOR_REVIEW',
        grade_reports: [
          makeGradeReport({
            status: 'FLAGGED',
            evaluation_flag: 'ACADEMIC_FAILURE',
          }),
        ],
      });

      expect(result.academic_standing.standing_type).toBe('ACTION_REQUIRED');
      expect(result.academic_standing.is_flagged).toBe(true);
    });

    it('marks an ineligible report as action required', async () => {
      const result = await loadDashboard({
        academic_baseline_status: 'PENDING_COORDINATOR_REVIEW',
        grade_reports: [makeGradeReport({ is_eligible: false })],
      });

      expect(result.academic_standing.standing_type).toBe('ACTION_REQUIRED');
      expect(result.academic_standing.is_flagged).toBe(true);
    });

    it('derives curriculum totals from subjects when the total is missing', async () => {
      const result = await loadDashboard({
        academic_baseline_status: 'PENDING_COORDINATOR_REVIEW',
        prospectus: {
          prospectus_id: 60,
          total_units: 0,
          is_frozen: true,
          status: 'FROZEN',
          subjects: [
            makeSubject({ status: 'PASSED', units: 4, grade: 2.0 }),
            makeSubject({ status: 'UNTAKEN', units: 3, grade: null }),
          ],
        },
      });

      expect(result.curriculum.total_units).toBe(7);
      expect(result.curriculum.passed_units).toBe(4);
      expect(result.curriculum.percentage).toBe(57);
      expect(result.curriculum.is_frozen).toBe(true);
      expect(result.curriculum.prospectus_status).toBe('FROZEN');
    });

    it('throws NotFoundException when the dashboard scholar is missing', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue(null);

      await expect(service.getScholarDashboardSummary(7)).rejects.toThrow(
        new NotFoundException('Scholar profile not found.'),
      );
    });
  });
});
