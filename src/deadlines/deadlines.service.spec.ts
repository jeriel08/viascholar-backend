import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditService } from '../audit/audit.service.js';
import { ChatService } from '../chat/chat.service.js';
import { ChatMessagesService } from '../chat/services/chat-messages.service.js';
import { EventsGateway } from '../events/events.gateway.js';
import { MailService } from '../mail/mail.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { DeadlinesService } from './deadlines.service.js';

const createPrismaMock = () => ({
  submissionDeadline: {
    findMany: vi.fn().mockResolvedValue([]),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  deadlineFollowUp: {
    create: vi.fn(),
  },
  deadlineExemption: {
    findMany: vi.fn().mockResolvedValue([]),
    upsert: vi.fn(),
    deleteMany: vi.fn(),
  },
  school: {
    findUnique: vi.fn(),
    findMany: vi.fn().mockResolvedValue([]),
  },
  scholarProfile: {
    findMany: vi.fn().mockResolvedValue([]),
    findUnique: vi.fn(),
  },
  employee: {
    findUnique: vi.fn(),
  },
});

const makeDeadlineRow = (overrides: Record<string, unknown> = {}) => ({
  deadline_id: 1,
  requirement_type: 'ENROLLMENT',
  academic_year: '2026-2027',
  semester: '1st Semester',
  school_id: null,
  school: null,
  due_date: new Date('2026-10-01T23:59:59.999+08:00'),
  grace_period_days: 0,
  is_optional_term: false,
  title: 'Start-of-Term Enrollment (COR & SOA) — 2026-2027 1st Semester',
  instructions: null,
  is_active: true,
  created_by_user_id: 2,
  created_by: {
    user_id: 2,
    email: 'coord@example.com',
    employee: { first_name: 'Maria', last_name: 'Santos' },
  },
  created_at: new Date('2026-09-15T00:00:00.000Z'),
  updated_at: new Date('2026-09-15T00:00:00.000Z'),
  ...overrides,
});

const makeScholarRow = (overrides: Record<string, unknown> = {}) => ({
  profile_id: 10,
  user_id: 100,
  first_name: 'Juan',
  last_name: 'Dela Cruz',
  student_number: '2024-001',
  course_of_study: 'BSIT',
  current_year_level: 2,
  school_id: 1,
  school_name: 'University of Mindanao',
  phone_number: '09171234567',
  user: { user_id: 100, email: 'juan@example.com' },
  school: {
    school_id: 1,
    school_name: 'University of Mindanao',
    school_code: 'UM',
  },
  school_grading_system: null,
  prospectus: { subjects: [] },
  enrollments: [],
  grade_reports: [],
  deadline_exemptions: [],
  deadline_follow_ups: [],
  ...overrides,
});

describe('DeadlinesService', () => {
  let service: DeadlinesService;
  let prisma: ReturnType<typeof createPrismaMock>;
  let settingsService: { getAcademicTermStatus: ReturnType<typeof vi.fn> };
  let chatService: { getOrCreateConversation: ReturnType<typeof vi.fn> };
  let chatMessagesService: { sendMessage: ReturnType<typeof vi.fn> };
  let mailService: { sendDeadlineFollowUpEmail: ReturnType<typeof vi.fn> };
  let notificationsService: { notifyUser: ReturnType<typeof vi.fn> };
  let auditService: { log: ReturnType<typeof vi.fn> };
  let eventsGateway: {
    emitToAll: ReturnType<typeof vi.fn>;
    emitToStaff: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-10T10:00:00.000Z'));

    prisma = createPrismaMock();
    settingsService = {
      getAcademicTermStatus: vi.fn().mockResolvedValue({
        effective_academic_year: '2026-2027',
        effective_semester: '1st Semester',
      }),
    };
    chatService = {
      getOrCreateConversation: vi.fn().mockResolvedValue({ conversation_id: 55 }),
    };
    chatMessagesService = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 99 }),
    };
    mailService = {
      sendDeadlineFollowUpEmail: vi.fn().mockResolvedValue(undefined),
    };
    notificationsService = {
      notifyUser: vi.fn().mockResolvedValue(null),
    };
    auditService = { log: vi.fn() };
    eventsGateway = { emitToAll: vi.fn(), emitToStaff: vi.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeadlinesService,
        { provide: PrismaService, useValue: prisma },
        { provide: SettingsService, useValue: settingsService },
        { provide: ChatService, useValue: chatService },
        { provide: ChatMessagesService, useValue: chatMessagesService },
        { provide: MailService, useValue: mailService },
        { provide: NotificationsService, useValue: notificationsService },
        { provide: AuditService, useValue: auditService },
        { provide: EventsGateway, useValue: eventsGateway },
      ],
    }).compile();

    service = module.get<DeadlinesService>(DeadlinesService);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('createDeadline', () => {
    it('creates a global deadline, defaults is_optional_term=true for Summer, and rejects duplicates', async () => {
      prisma.submissionDeadline.findFirst.mockResolvedValueOnce(null);
      prisma.submissionDeadline.create.mockResolvedValueOnce(
        makeDeadlineRow({
          deadline_id: 3,
          semester: 'Summer',
          is_optional_term: true,
        }),
      );

      const created = await service.createDeadline(2, {
        requirement_type: 'ENROLLMENT',
        academic_year: '2026-2027',
        semester: 'Summer',
        due_date: '2026-10-15',
      });

      expect(prisma.submissionDeadline.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            academic_year: '2026-2027',
            semester: 'Summer',
            is_optional_term: true,
            school_id: null,
          }),
        }),
      );
      expect(created.is_optional_term).toBe(true);
      expect(eventsGateway.emitToAll).toHaveBeenCalledWith(
        'deadline:updated',
        expect.objectContaining({ action: 'CREATED' }),
      );

      prisma.submissionDeadline.findFirst.mockResolvedValueOnce({
        deadline_id: 3,
      });
      await expect(
        service.createDeadline(2, {
          requirement_type: 'ENROLLMENT',
          academic_year: '2026-2027',
          semester: 'Summer',
          due_date: '2026-10-20',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('broadcasts new deadline notifications only to scholars who have not submitted and need action', async () => {
      const deadlineRow = makeDeadlineRow({
        deadline_id: 10,
        requirement_type: 'ENROLLMENT',
        academic_year: '2026-2027',
        semester: 'Summer',
        is_optional_term: true,
        due_date: new Date('2026-10-15T23:59:59.999+08:00'),
      });
      prisma.submissionDeadline.findFirst.mockResolvedValueOnce(null);
      prisma.submissionDeadline.create.mockResolvedValueOnce(deadlineRow);
      prisma.submissionDeadline.findMany.mockResolvedValueOnce([deadlineRow]);
      prisma.scholarProfile.findMany.mockResolvedValueOnce([
        // Scholar 1: Already submitted -> skip
        makeScholarRow({
          profile_id: 1,
          user_id: 101,
          enrollments: [
            {
              enrollment_id: 501,
              academic_year: '2026-2027',
              semester: 'Summer',
              status: 'PENDING_REVIEW',
            },
          ],
        }),
        // Scholar 2: Ongoing ungraded enrollment -> CURRENTLY_ENROLLED -> skip
        makeScholarRow({
          profile_id: 2,
          user_id: 102,
          enrollments: [
            {
              enrollment_id: 502,
              academic_year: '2024-2025',
              semester: '1st Semester',
              status: 'APPROVED',
            },
          ],
        }),
        // Scholar 3: Optional Summer with no summer subjects -> NOT_APPLICABLE -> skip
        makeScholarRow({
          profile_id: 3,
          user_id: 103,
          prospectus: { subjects: [{ year_level: 2, semester: '1st Semester', status: 'PASSED' }] },
        }),
        // Scholar 4: Has untaken Summer subject and no enrollment -> notify!
        makeScholarRow({
          profile_id: 4,
          user_id: 104,
          current_year_level: 2,
          prospectus: { subjects: [{ year_level: 2, semester: 'Summer', status: 'UNTAKEN' }] },
        }),
      ]);

      await service.createDeadline(2, {
        requirement_type: 'ENROLLMENT',
        academic_year: '2026-2027',
        semester: 'Summer',
        due_date: '2026-10-15',
        notify_scholars: true,
      });

      expect(notificationsService.notifyUser).toHaveBeenCalledTimes(1);
      expect(notificationsService.notifyUser).toHaveBeenCalledWith(
        104,
        expect.objectContaining({ category: 'deadline' }),
      );
    });
  });

  describe('getCompliance', () => {
    it('prefers per-school overrides, respects grace period, and handles Summer/Grades without false overdue flags', async () => {
      const globalEnrollment = makeDeadlineRow({
        deadline_id: 1,
        requirement_type: 'ENROLLMENT',
        academic_year: '2026-2027',
        semester: 'Summer',
        school_id: null,
        due_date: new Date('2026-10-01T23:59:59.999+08:00'),
        grace_period_days: 0,
        is_optional_term: true,
      });
      const schoolOverrideEnrollment = makeDeadlineRow({
        deadline_id: 2,
        requirement_type: 'ENROLLMENT',
        academic_year: '2026-2027',
        semester: 'Summer',
        school_id: 2,
        school: { school_id: 2, school_name: 'Ateneo', school_code: 'ADDU' },
        due_date: new Date('2026-10-12T23:59:59.999+08:00'),
        grace_period_days: 3,
        is_optional_term: true,
      });
      const summerGrades = makeDeadlineRow({
        deadline_id: 3,
        requirement_type: 'GRADES',
        academic_year: '2026-2027',
        semester: 'Summer',
        school_id: null,
        due_date: new Date('2026-10-05T23:59:59.999+08:00'),
        grace_period_days: 0,
        is_optional_term: true,
      });

      prisma.submissionDeadline.findMany.mockResolvedValue([
        globalEnrollment,
        schoolOverrideEnrollment,
        summerGrades,
      ]);

      prisma.scholarProfile.findMany.mockResolvedValue([
        // Scholar A: School 1, has Summer subject in Year 2 prospectus, no enrollment yet -> Enrollment OVERDUE, Grades NOT_APPLICABLE
        makeScholarRow({
          profile_id: 10,
          school_id: 1,
          current_year_level: 2,
          prospectus: {
            subjects: [{ year_level: 2, semester: 'Summer', status: 'UNTAKEN' }],
          },
        }),
        // Scholar B: School 2 (override due Oct 12 + 3d), has Summer enrollment APPROVED, no grade report -> Enrollment SUBMITTED, Grades OVERDUE
        makeScholarRow({
          profile_id: 20,
          user_id: 200,
          first_name: 'Ana',
          last_name: 'Reyes',
          school_id: 2,
          school_name: 'Ateneo',
          school: { school_id: 2, school_name: 'Ateneo', school_code: 'ADDU' },
          enrollments: [
            {
              enrollment_id: 90,
              academic_year: '2026-2027',
              semester: 'Summer',
              status: 'APPROVED',
            },
          ],
        }),
        // Scholar C: School 1, no Summer subjects in prospectus & no enrollment -> both NOT_APPLICABLE
        makeScholarRow({
          profile_id: 30,
          user_id: 300,
          first_name: 'Pedro',
          last_name: 'Santos',
          school_id: 1,
          prospectus: { subjects: [{ year_level: 2, semester: '1st Semester', status: 'PASSED' }] },
        }),
        // Scholar D: School 1, exempt on Enrollment
        makeScholarRow({
          profile_id: 40,
          user_id: 400,
          first_name: 'Liza',
          last_name: 'Cruz',
          school_id: 1,
          prospectus: {
            subjects: [{ year_level: 2, semester: 'Summer', status: 'UNTAKEN' }],
          },
          deadline_exemptions: [{ deadline_id: 1, reason: 'On LOA' }],
        }),
      ]);

      const result = await service.getCompliance({
        academic_year: '2026-2027',
        semester: 'Summer',
      });

      const byKey = new Map(result.items.map((i) => [i.row_key, i]));

      // Scholar A
      expect(byKey.get('1-10')?.status).toBe('OVERDUE');
      expect(byKey.get('3-10')?.status).toBe('NOT_APPLICABLE');

      // Scholar B used school 2 override (deadline_id 2)
      expect(byKey.get('2-20')?.status).toBe('SUBMITTED');
      expect(byKey.get('2-20')?.is_school_override).toBe(true);
      expect(byKey.get('3-20')?.status).toBe('OVERDUE');

      // Scholar C (not taking Summer)
      expect(byKey.get('1-30')?.status).toBe('NOT_APPLICABLE');
      expect(byKey.get('3-30')?.status).toBe('NOT_APPLICABLE');

      // Scholar D (exempt)
      expect(byKey.get('1-40')?.status).toBe('EXEMPT');
      expect(result.summary.exempt_count).toBe(1);
      expect(result.summary.overdue_count).toBe(2);
    });

    it('marks ongoing ungraded enrollment as CURRENTLY_ENROLLED and resolves canonical school name/id despite grading ID collision', async () => {
      const globalEnrollment = makeDeadlineRow({
        deadline_id: 1,
        requirement_type: 'ENROLLMENT',
        academic_year: '2026-2027',
        semester: '1st Semester',
        school_id: null,
        due_date: new Date('2026-10-01T23:59:59.999+08:00'),
        grace_period_days: 0,
      });
      const ateneoOverride = makeDeadlineRow({
        deadline_id: 2,
        requirement_type: 'ENROLLMENT',
        academic_year: '2026-2027',
        semester: '1st Semester',
        school_id: 3,
        school: {
          school_id: 3,
          school_name: 'Ateneo de Davao University',
          school_code: 'ADDU',
        },
        due_date: new Date('2026-10-15T23:59:59.999+08:00'),
        grace_period_days: 0,
      });

      prisma.submissionDeadline.findMany.mockResolvedValue([
        globalEnrollment,
        ateneoOverride,
      ]);
      prisma.school.findMany.mockResolvedValue([
        { school_id: 2, school_name: 'University of Mindanao' },
        { school_id: 3, school_name: 'Ateneo de Davao University' },
      ]);
      prisma.scholarProfile.findMany.mockResolvedValue([
        // Ongoing AY 2024-2025 1st Sem APPROVED without grade report, plus school_id=3 grading collision with Ateneo
        makeScholarRow({
          profile_id: 1,
          user_id: 11,
          first_name: 'Jeriel',
          last_name: 'Sanao',
          school_id: 3,
          school_name: 'University of Mindanao',
          school: {
            school_id: 3,
            school_name: 'Ateneo de Davao University',
            school_code: 'ADDU',
          },
          school_grading_system: {
            school_id: 3,
            school_name: 'University of Mindanao',
          },
          enrollments: [
            {
              enrollment_id: 8,
              academic_year: '2024-2025',
              semester: '1st Semester',
              status: 'APPROVED',
            },
          ],
          grade_reports: [],
        }),
        // Prior enrollment already COMPLETED with grade -> missing next enrollment -> OVERDUE
        makeScholarRow({
          profile_id: 3,
          user_id: 13,
          first_name: 'Clairre',
          last_name: 'Abes',
          school_id: 3,
          school_name: 'University of Mindanao',
          school: {
            school_id: 3,
            school_name: 'Ateneo de Davao University',
            school_code: 'ADDU',
          },
          school_grading_system: {
            school_id: 3,
            school_name: 'University of Mindanao',
          },
          enrollments: [
            {
              enrollment_id: 6,
              academic_year: '2023-2024',
              semester: '1st Semester',
              status: 'COMPLETED',
            },
          ],
          grade_reports: [
            {
              report_id: 6,
              academic_year: '2023-2024',
              semester: '1st Semester',
              status: 'FLAGGED',
              appeal_status: 'APPROVED',
            },
          ],
        }),
      ]);

      const result = await service.getCompliance({
        academic_year: '2026-2027',
        semester: '1st Semester',
      });

      const byProfile = new Map(result.items.map((i) => [i.scholar.profile_id, i]));

      const jeriel = byProfile.get(1);
      expect(jeriel?.status).toBe('CURRENTLY_ENROLLED');
      expect(jeriel?.deadline_id).toBe(1);
      expect(jeriel?.is_school_override).toBe(false);
      expect(jeriel?.scholar.school_name).toBe('University of Mindanao');
      expect(jeriel?.scholar.school_id).toBe(2);

      const clairre = byProfile.get(3);
      expect(clairre?.status).toBe('OVERDUE');
      expect(clairre?.deadline_id).toBe(1);
      expect(clairre?.scholar.school_name).toBe('University of Mindanao');
      expect(clairre?.scholar.school_id).toBe(2);

      expect(result.summary.currently_enrolled_count).toBe(1);
      expect(result.summary.overdue_count).toBe(1);
      expect(result.summary.missing_count).toBe(1);
      expect(result.available_academic_years).toEqual(
        expect.arrayContaining(['2026-2027', '2024-2025', '2023-2024']),
      );
    });
  });

  describe('listDeadlines with include_summary & getDeadlineDetailCompliance', () => {
    it('attaches covered scholar summary counts per deadline while excluding school-overridden scholars from global deadlines', async () => {
      const globalDeadline = makeDeadlineRow({
        deadline_id: 1,
        requirement_type: 'ENROLLMENT',
        academic_year: '2026-2027',
        semester: '1st Semester',
        school_id: null,
        due_date: new Date('2026-10-01T23:59:59.999+08:00'),
      });
      const ateneoOverride = makeDeadlineRow({
        deadline_id: 2,
        requirement_type: 'ENROLLMENT',
        academic_year: '2026-2027',
        semester: '1st Semester',
        school_id: 3,
        school: {
          school_id: 3,
          school_name: 'Ateneo de Davao University',
          school_code: 'ADDU',
        },
        due_date: new Date('2026-10-15T23:59:59.999+08:00'),
      });

      prisma.submissionDeadline.findMany
        .mockResolvedValueOnce([globalDeadline, ateneoOverride])
        .mockResolvedValueOnce([globalDeadline, ateneoOverride]);
      prisma.scholarProfile.findMany.mockResolvedValue([
        makeScholarRow({ profile_id: 10, school_id: 2, school_name: 'University of Mindanao' }),
        makeScholarRow({
          profile_id: 20,
          user_id: 200,
          school_id: 3,
          school_name: 'Ateneo de Davao University',
          school: {
            school_id: 3,
            school_name: 'Ateneo de Davao University',
            school_code: 'ADDU',
          },
        }),
      ]);

      const rows = (await service.listDeadlines({ include_summary: true })) as Array<any>;

      expect(rows).toHaveLength(2);
      expect(rows[0].summary.total_in_scope).toBe(1);
      expect(rows[0].summary.overdue_count).toBe(1);
      expect(rows[1].summary.total_in_scope).toBe(1);
      expect(rows[1].summary.upcoming_count).toBe(1);
    });

    it('returns selected deadline details, overridden schools, and only its covered scholars', async () => {
      const globalDeadline = makeDeadlineRow({
        deadline_id: 1,
        requirement_type: 'ENROLLMENT',
        academic_year: '2026-2027',
        semester: '1st Semester',
        school_id: null,
        due_date: new Date('2026-10-01T23:59:59.999+08:00'),
      });
      const ateneoOverride = makeDeadlineRow({
        deadline_id: 2,
        requirement_type: 'ENROLLMENT',
        academic_year: '2026-2027',
        semester: '1st Semester',
        school_id: 3,
        school: {
          school_id: 3,
          school_name: 'Ateneo de Davao University',
          school_code: 'ADDU',
        },
      });

      prisma.submissionDeadline.findUnique.mockResolvedValueOnce(globalDeadline);
      prisma.submissionDeadline.findMany.mockResolvedValueOnce([
        globalDeadline,
        ateneoOverride,
      ]);
      prisma.scholarProfile.findMany.mockResolvedValueOnce([
        makeScholarRow({ profile_id: 10, school_id: 2, school_name: 'University of Mindanao' }),
        makeScholarRow({
          profile_id: 20,
          user_id: 200,
          first_name: 'Ateneo',
          last_name: 'Scholar',
          school_id: 3,
          school_name: 'Ateneo de Davao University',
          school: {
            school_id: 3,
            school_name: 'Ateneo de Davao University',
            school_code: 'ADDU',
          },
        }),
      ]);

      const detail = await service.getDeadlineDetailCompliance(1, {});

      expect(detail.deadline.deadline_id).toBe(1);
      expect(detail.overridden_schools).toEqual([
        {
          deadline_id: 2,
          school_id: 3,
          school_name: 'Ateneo de Davao University',
        },
      ]);
      expect(detail.items).toHaveLength(1);
      expect(detail.items[0].scholar.profile_id).toBe(10);
      expect(detail.summary.covered_count).toBe(1);

      prisma.submissionDeadline.findUnique.mockResolvedValueOnce(null);
      await expect(service.getDeadlineDetailCompliance(999, {})).rejects.toThrow(
        NotFoundException,
      );
    });

    it('tracks VERIFIED_READY counts, total verified assessment, and pending CCG document_id', async () => {
      const enrollmentDeadline = makeDeadlineRow({
        deadline_id: 1,
        requirement_type: 'ENROLLMENT',
        academic_year: '2026-2027',
        semester: '1st Semester',
      });
      const verifiedScholar = makeScholarRow({
        profile_id: 10,
        user_id: 101,
        first_name: 'Maria',
        last_name: 'Santos',
        enrollments: [
          {
            enrollment_id: 51,
            academic_year: '2026-2027',
            semester: '1st Semester',
            status: 'VERIFIED',
            total_assessment: 18500,
            total_units: 21,
            cor_document_id: 71,
            soa_document_id: 72,
            audit_flags: [],
            created_at: new Date('2026-10-02T08:00:00Z'),
            updated_at: new Date('2026-10-03T08:00:00Z'),
          },
        ],
      });
      const pendingScholar = makeScholarRow({
        profile_id: 20,
        user_id: 102,
        first_name: 'Jose',
        last_name: 'Reyes',
        enrollments: [
          {
            enrollment_id: 52,
            academic_year: '2026-2027',
            semester: '1st Semester',
            status: 'PENDING_REVIEW',
            total_assessment: 12000,
            total_units: 18,
            cor_document_id: 73,
            soa_document_id: 74,
            audit_flags: ['UNIT_MISMATCH'],
            created_at: new Date('2026-10-04T08:00:00Z'),
            updated_at: new Date('2026-10-04T08:00:00Z'),
          },
        ],
      });

      prisma.submissionDeadline.findUnique.mockResolvedValueOnce(enrollmentDeadline);
      prisma.submissionDeadline.findMany.mockResolvedValueOnce([enrollmentDeadline]);
      prisma.scholarProfile.findMany.mockResolvedValueOnce([
        verifiedScholar,
        pendingScholar,
      ]);

      const detail = await service.getDeadlineDetailCompliance(1, {});
      expect(detail.summary.verified_ready_count).toBe(1);
      expect(detail.summary.pending_audit_count).toBe(1);
      expect(detail.summary.verified_total_amount).toBe(18500);

      const verifiedRow = detail.items.find((i) => i.scholar.profile_id === 10);
      const pendingRow = detail.items.find((i) => i.scholar.profile_id === 20);
      expect(verifiedRow?.submission?.review_stage).toBe('VERIFIED_READY');
      expect(verifiedRow?.submission?.total_assessment).toBe(18500);
      expect(pendingRow?.submission?.review_stage).toBe('PENDING_AUDIT');
      expect(pendingRow?.submission?.audit_flags_count).toBe(1);

      const gradesDeadline = makeDeadlineRow({
        deadline_id: 2,
        requirement_type: 'GRADES',
        academic_year: '2026-2027',
        semester: '1st Semester',
      });
      const ccgScholar = makeScholarRow({
        profile_id: 30,
        user_id: 103,
        enrollments: [
          {
            enrollment_id: 53,
            academic_year: '2026-2027',
            semester: '1st Semester',
            status: 'APPROVED',
          },
        ],
        grade_reports: [],
        documents: [
          {
            document_id: 88,
            document_type: 'CCG',
            status: 'STUDENT_CONFIRMED',
            confirmed_data: {
              academic_year: '2026-2027',
              semester: '1st Semester',
            },
            extracted_data: null,
            uploaded_at: new Date('2026-10-10T09:00:00Z'),
            verified_at: null,
          },
        ],
      });

      prisma.submissionDeadline.findUnique.mockResolvedValueOnce(gradesDeadline);
      prisma.submissionDeadline.findMany.mockResolvedValueOnce([gradesDeadline]);
      prisma.scholarProfile.findMany.mockResolvedValueOnce([ccgScholar]);

      const gradeDetail = await service.getDeadlineDetailCompliance(2, {
        status: 'PENDING_AUDIT',
      });
      expect(gradeDetail.summary.pending_audit_count).toBe(1);
      expect(gradeDetail.items).toHaveLength(1);
      expect(gradeDetail.items[0].status).toBe('SUBMITTED');
      expect(gradeDetail.items[0].submission?.review_stage).toBe('PENDING_AUDIT');
      expect(gradeDetail.items[0].submission?.grade_document_id).toBe(88);
    });
  });

  describe('sendFollowUp', () => {
    it('dispatches chat message, email, and notification and logs DeadlineFollowUp', async () => {
      prisma.submissionDeadline.findUnique.mockResolvedValue(
        makeDeadlineRow({ deadline_id: 1 }),
      );
      prisma.scholarProfile.findMany.mockResolvedValue([
        makeScholarRow({ profile_id: 10, user_id: 100 }),
      ]);
      prisma.employee.findUnique.mockResolvedValue({
        first_name: 'Maria',
        last_name: 'Santos',
      });
      prisma.deadlineFollowUp.create.mockResolvedValue({ follow_up_id: 77 });

      const res = await service.sendFollowUp(2, {
        deadline_id: 1,
        scholar_profile_ids: [10],
        message: 'Hi Juan, please let me know why your COR is not uploaded yet.',
        send_chat: true,
        send_email: true,
        send_notification: true,
      });

      expect(chatService.getOrCreateConversation).toHaveBeenCalledWith(2, {
        target_user_id: 100,
        subject: expect.stringContaining('Start-of-Term Enrollment'),
      });
      expect(chatMessagesService.sendMessage).toHaveBeenCalledWith(2, 55, {
        message_text:
          'Hi Juan, please let me know why your COR is not uploaded yet.',
      });
      expect(mailService.sendDeadlineFollowUpEmail).toHaveBeenCalledWith(
        'juan@example.com',
        expect.objectContaining({
          studentName: 'Juan Dela Cruz',
          isOverdue: true,
          coordinatorName: 'Maria Santos',
        }),
      );
      expect(notificationsService.notifyUser).toHaveBeenCalledWith(
        100,
        expect.objectContaining({
          category: 'deadline',
          link: '/scholarMessage?conversationId=55',
        }),
      );
      expect(prisma.deadlineFollowUp.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          deadline_id: 1,
          scholar_profile_id: 10,
          conversation_id: 55,
          channels: ['CHAT', 'EMAIL', 'IN_APP'],
        }),
      });
      expect(res.sent_count).toBe(1);
    });

    it('rejects when all channels are disabled', async () => {
      prisma.submissionDeadline.findUnique.mockResolvedValue(
        makeDeadlineRow({ deadline_id: 1 }),
      );
      prisma.scholarProfile.findMany.mockResolvedValue([makeScholarRow()]);

      await expect(
        service.sendFollowUp(2, {
          deadline_id: 1,
          scholar_profile_ids: [10],
          message: 'Reminder',
          send_chat: false,
          send_email: false,
          send_notification: false,
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('getMyDeadlines', () => {
    it('returns active deadlines evaluated for the logged-in scholar', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue(
        makeScholarRow({ profile_id: 10, user_id: 100 }),
      );
      prisma.submissionDeadline.findMany.mockResolvedValue([
        makeDeadlineRow({
          deadline_id: 1,
          requirement_type: 'ENROLLMENT',
          due_date: new Date('2026-10-15T23:59:59.999+08:00'),
        }),
      ]);

      const res = await service.getMyDeadlines(100);

      expect(res.academic_year).toBe('2026-2027');
      expect(res.deadlines).toHaveLength(1);
      expect(res.deadlines[0].status).toBe('UPCOMING');
    });

    it('includes active GRADES deadline for an ongoing ungraded earlier-term enrollment', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue(
        makeScholarRow({
          profile_id: 1,
          user_id: 100,
          enrollments: [
            {
              enrollment_id: 8,
              academic_year: '2024-2025',
              semester: '1st Semester',
              status: 'APPROVED',
            },
          ],
          grade_reports: [],
        }),
      );
      prisma.submissionDeadline.findMany.mockResolvedValue([
        makeDeadlineRow({
          deadline_id: 1,
          requirement_type: 'ENROLLMENT',
          academic_year: '2026-2027',
          semester: '1st Semester',
        }),
        makeDeadlineRow({
          deadline_id: 9,
          requirement_type: 'GRADES',
          academic_year: '2024-2025',
          semester: '1st Semester',
          due_date: new Date('2026-10-15T23:59:59.999+08:00'),
        }),
      ]);

      const res = await service.getMyDeadlines(100);

      const byId = new Map(res.deadlines.map((d) => [d.deadline_id, d]));
      expect(byId.get(1)?.status).toBe('CURRENTLY_ENROLLED');
      expect(byId.get(9)?.requirement_type).toBe('GRADES');
      expect(byId.get(9)?.academic_year).toBe('2024-2025');
      expect(byId.get(9)?.status).toBe('UPCOMING');
    });

    it('throws NotFoundException when scholar profile is missing', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue(null);
      await expect(service.getMyDeadlines(999)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('academic locks (ON_HOLD) & late submission tracking', () => {
    it('detects appeal, program shift, and discontinued locks as ON_HOLD and excludes them from overdue alerts & broadcast notifications', async () => {
      const overdueDeadline = makeDeadlineRow({
        deadline_id: 1,
        requirement_type: 'ENROLLMENT',
        academic_year: '2026-2027',
        semester: '1st Semester',
        due_date: new Date('2026-10-01T23:59:59.999+08:00'),
        grace_period_days: 0,
      });

      const appealPendingScholar = makeScholarRow({
        profile_id: 11,
        user_id: 111,
        first_name: 'Appeal',
        last_name: 'Pending',
        grade_reports: [
          {
            report_id: 301,
            academic_year: '2025-2026',
            semester: '2nd Semester',
            status: 'FLAGGED',
            appeal_status: 'PENDING_GRANTOR',
            submitted_at: new Date('2026-08-01T00:00:00.000Z'),
          },
        ],
      });

      const appealRequiredScholar = makeScholarRow({
        profile_id: 12,
        user_id: 112,
        first_name: 'Appeal',
        last_name: 'Required',
        grade_reports: [
          {
            report_id: 302,
            academic_year: '2025-2026',
            semester: '2nd Semester',
            status: 'FLAGGED',
            appeal_status: 'NONE',
            submitted_at: new Date('2026-08-02T00:00:00.000Z'),
          },
        ],
      });

      const shiftProspectusScholar = makeScholarRow({
        profile_id: 13,
        user_id: 113,
        first_name: 'Shift',
        last_name: 'Prospectus',
        academic_baseline_status: 'PENDING_SHIFT_PROSPECTUS',
      });

      const pendingShiftScholar = makeScholarRow({
        profile_id: 14,
        user_id: 114,
        first_name: 'Shift',
        last_name: 'Request',
        academic_change_requests: [
          {
            request_id: 1,
            change_type: 'PROGRAM_SHIFT',
            status: 'PENDING_GRANTOR',
            created_at: new Date('2026-09-20T00:00:00.000Z'),
          },
        ],
      });

      const discontinuedScholar = makeScholarRow({
        profile_id: 15,
        user_id: 115,
        first_name: 'Discontinued',
        last_name: 'Scholar',
        academic_baseline_status: 'DISCONTINUED',
        enrollments: [
          {
            enrollment_id: 400,
            academic_year: '2025-2026',
            semester: '2nd Semester',
            status: 'APPROVED',
          },
        ],
      });

      prisma.submissionDeadline.findUnique.mockResolvedValueOnce(overdueDeadline);
      prisma.submissionDeadline.findMany.mockResolvedValueOnce([overdueDeadline]);
      prisma.scholarProfile.findMany.mockResolvedValueOnce([
        appealPendingScholar,
        appealRequiredScholar,
        shiftProspectusScholar,
        pendingShiftScholar,
        discontinuedScholar,
      ]);

      const detail = await service.getDeadlineDetailCompliance(1, {});
      expect(detail.summary.overdue_count).toBe(0);
      expect(detail.summary.missing_count).toBe(0);
      expect(detail.summary.on_hold_count).toBe(5);

      const byProfile = new Map(
        detail.items.map((item) => [item.scholar.profile_id, item]),
      );
      expect(byProfile.get(11)?.status).toBe('ON_HOLD');
      expect(byProfile.get(11)?.lock?.reason).toBe('APPEAL_PENDING');
      expect(byProfile.get(11)?.days_overdue).toBe(0);
      expect(byProfile.get(12)?.status).toBe('ON_HOLD');
      expect(byProfile.get(12)?.lock?.reason).toBe('APPEAL_REQUIRED');
      expect(byProfile.get(13)?.status).toBe('ON_HOLD');
      expect(byProfile.get(13)?.lock?.reason).toBe('ACADEMIC_SHIFT_IN_PROGRESS');
      expect(byProfile.get(14)?.status).toBe('ON_HOLD');
      expect(byProfile.get(14)?.lock?.reason).toBe('SHIFT_REQUEST_PENDING');
      expect(byProfile.get(15)?.status).toBe('ON_HOLD');
      expect(byProfile.get(15)?.lock?.reason).toBe('DISCONTINUED');

      // Broadcast notification excludes DISCONTINUED / ON_HOLD scholars
      const newDeadline = makeDeadlineRow({
        deadline_id: 22,
        requirement_type: 'ENROLLMENT',
        academic_year: '2026-2027',
        semester: '1st Semester',
        due_date: new Date('2026-10-15T23:59:59.999+08:00'),
      });
      const eligibleScholar = makeScholarRow({ profile_id: 99, user_id: 199 });
      prisma.submissionDeadline.findFirst.mockResolvedValueOnce(null);
      prisma.submissionDeadline.create.mockResolvedValueOnce(newDeadline);
      prisma.submissionDeadline.findMany.mockResolvedValueOnce([newDeadline]);
      prisma.scholarProfile.findMany.mockResolvedValueOnce([
        discontinuedScholar,
        appealPendingScholar,
        eligibleScholar,
      ]);

      await service.createDeadline(2, {
        requirement_type: 'ENROLLMENT',
        academic_year: '2026-2027',
        semester: '1st Semester',
        due_date: '2026-10-15',
        notify_scholars: true,
      });

      expect(notificationsService.notifyUser).toHaveBeenCalledTimes(1);
      expect(notificationsService.notifyUser).toHaveBeenCalledWith(
        199,
        expect.objectContaining({ category: 'deadline' }),
      );
    });

    it('tracks late ENROLLMENT and GRADES submissions accurately without false-flagging coordinator reviews after cutoff', async () => {
      const enrollmentDeadline = makeDeadlineRow({
        deadline_id: 1,
        requirement_type: 'ENROLLMENT',
        academic_year: '2026-2027',
        semester: '1st Semester',
        due_date: new Date('2026-10-01T23:59:59.999+08:00'),
        grace_period_days: 0,
      });

      // Submitted 4 days after effective cutoff (2026-10-01T15:59:59.999Z)
      const lateEnrollmentScholar = makeScholarRow({
        profile_id: 21,
        user_id: 201,
        first_name: 'Late',
        last_name: 'Enrollee',
        enrollments: [
          {
            enrollment_id: 601,
            academic_year: '2026-2027',
            semester: '1st Semester',
            status: 'PENDING_REVIEW',
            total_assessment: 14000,
            total_units: 18,
            cor_document: { uploaded_at: new Date('2026-10-05T15:59:59.999Z') },
            soa_document: { uploaded_at: new Date('2026-10-05T15:59:59.999Z') },
            created_at: new Date('2026-10-05T14:00:00.000Z'),
            updated_at: new Date('2026-10-05T15:59:59.999Z'),
          },
        ],
      });

      // Uploaded BEFORE cutoff, reviewed/approved AFTER cutoff -> NOT late
      const reviewedAfterCutoffScholar = makeScholarRow({
        profile_id: 22,
        user_id: 202,
        first_name: 'Ontime',
        last_name: 'ApprovedLater',
        enrollments: [
          {
            enrollment_id: 602,
            academic_year: '2026-2027',
            semester: '1st Semester',
            status: 'APPROVED',
            total_assessment: 16000,
            total_units: 21,
            cor_document: { uploaded_at: new Date('2026-09-28T08:00:00.000Z') },
            soa_document: { uploaded_at: new Date('2026-09-29T08:00:00.000Z') },
            created_at: new Date('2026-09-29T08:00:00.000Z'),
            reviewed_at: new Date('2026-10-06T09:00:00.000Z'),
            updated_at: new Date('2026-10-06T09:00:00.000Z'),
          },
        ],
      });

      prisma.submissionDeadline.findUnique.mockResolvedValueOnce(enrollmentDeadline);
      prisma.submissionDeadline.findMany.mockResolvedValueOnce([enrollmentDeadline]);
      prisma.scholarProfile.findMany.mockResolvedValueOnce([
        lateEnrollmentScholar,
        reviewedAfterCutoffScholar,
      ]);

      const enrollDetail = await service.getDeadlineDetailCompliance(1, {});
      expect(enrollDetail.summary.submitted_count).toBe(2);
      expect(enrollDetail.summary.submitted_late_count).toBe(1);

      const lateItem = enrollDetail.items.find((i) => i.scholar.profile_id === 21);
      const onTimeItem = enrollDetail.items.find((i) => i.scholar.profile_id === 22);
      expect(lateItem?.status).toBe('SUBMITTED');
      expect(lateItem?.is_late).toBe(true);
      expect(lateItem?.days_late).toBe(4);
      expect(lateItem?.submission?.is_late).toBe(true);
      expect(lateItem?.submission?.days_late).toBe(4);
      expect(lateItem?.status_detail).toContain('Late by 4d');
      expect(onTimeItem?.is_late).toBe(false);
      expect(onTimeItem?.days_late).toBe(0);

      prisma.submissionDeadline.findUnique.mockResolvedValueOnce(enrollmentDeadline);
      prisma.submissionDeadline.findMany.mockResolvedValueOnce([enrollmentDeadline]);
      prisma.scholarProfile.findMany.mockResolvedValueOnce([
        lateEnrollmentScholar,
        reviewedAfterCutoffScholar,
      ]);

      const lateOnlyFilter = await service.getDeadlineDetailCompliance(1, {
        status: 'SUBMITTED_LATE',
      });
      expect(lateOnlyFilter.items).toHaveLength(1);
      expect(lateOnlyFilter.items[0].scholar.profile_id).toBe(21);

      // GRADES deadline checks
      const gradesDeadline = makeDeadlineRow({
        deadline_id: 2,
        requirement_type: 'GRADES',
        academic_year: '2026-2027',
        semester: '1st Semester',
        due_date: new Date('2026-10-01T23:59:59.999+08:00'),
        grace_period_days: 0,
      });

      // CCG uploaded before cutoff, verified into GradeReport after cutoff -> NOT late
      const onTimeVerifiedGradeScholar = makeScholarRow({
        profile_id: 23,
        user_id: 203,
        grade_reports: [
          {
            report_id: 701,
            document_id: 901,
            academic_year: '2026-2027',
            semester: '1st Semester',
            status: 'APPROVED',
            submitted_at: new Date('2026-10-06T12:00:00.000Z'),
            document: { uploaded_at: new Date('2026-09-25T10:00:00.000Z') },
          },
        ],
      });

      // Pending CCG uploaded 3 days after cutoff -> Late by 3d
      const latePendingCcgScholar = makeScholarRow({
        profile_id: 24,
        user_id: 204,
        grade_reports: [],
        documents: [
          {
            document_id: 902,
            document_type: 'CCG',
            status: 'STUDENT_CONFIRMED',
            confirmed_data: {
              academic_year: '2026-2027',
              semester: '1st Semester',
            },
            extracted_data: null,
            uploaded_at: new Date('2026-10-04T15:59:59.999Z'),
            verified_at: null,
          },
        ],
      });

      prisma.submissionDeadline.findUnique.mockResolvedValueOnce(gradesDeadline);
      prisma.submissionDeadline.findMany.mockResolvedValueOnce([gradesDeadline]);
      prisma.scholarProfile.findMany.mockResolvedValueOnce([
        onTimeVerifiedGradeScholar,
        latePendingCcgScholar,
      ]);

      const gradesDetail = await service.getDeadlineDetailCompliance(2, {});
      expect(gradesDetail.summary.submitted_count).toBe(2);
      expect(gradesDetail.summary.submitted_late_count).toBe(1);

      const onTimeGradeItem = gradesDetail.items.find(
        (i) => i.scholar.profile_id === 23,
      );
      const lateCcgItem = gradesDetail.items.find(
        (i) => i.scholar.profile_id === 24,
      );
      expect(onTimeGradeItem?.is_late).toBe(false);
      expect(onTimeGradeItem?.days_late).toBe(0);
      expect(lateCcgItem?.status).toBe('SUBMITTED');
      expect(lateCcgItem?.is_late).toBe(true);
      expect(lateCcgItem?.days_late).toBe(3);
    });
  });
});
