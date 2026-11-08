import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ConflictException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ApplicationsService } from './applications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { MailService } from '../mail/mail.service.js';
import { EventsGateway } from '../events/events.gateway.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { AppCacheService } from '../common/cache/app-cache.service.js';
import { Role } from '../generated/prisma/enums.js';
import type { CreateApplicationDto } from './dto/create-application.dto.js';

// Asymmetric matchers are untyped; cast once so nested properties satisfy the linter.
const anyArg = (ctor: unknown) => expect.any(ctor) as unknown;
const objectMatching = (shape: Record<string, unknown>) =>
  expect.objectContaining(shape) as Record<string, unknown>;

const createPrismaMock = () => ({
  scholarProfile: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
  },
  schoolGradingSystem: {
    findFirst: vi.fn(),
  },
  school: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
  },
  academicProgram: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
  },
  application: {
    create: vi.fn(),
    update: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
  },
  gradeReport: {
    findMany: vi.fn(),
  },
  scholarDocument: {
    findMany: vi.fn(),
  },
});

const createAuditMock = () => ({ log: vi.fn() });
const createMailMock = () => ({
  sendApplicationSubmittedStudent: vi.fn(),
  sendApplicationSubmittedStaff: vi.fn(),
  getStaffEmails: vi.fn().mockResolvedValue([]),
});
const createEventsMock = () => ({
  emitToStaff: vi.fn(),
  emitToUser: vi.fn(),
  emitToAll: vi.fn(),
});
const createNotificationsMock = () => ({
  createForRoles: vi.fn(),
  notifyStaff: vi.fn(),
  notifyUser: vi.fn(),
});
const createCacheMock = () => ({
  delPattern: vi.fn(),
  del: vi.fn(),
  wrap: vi.fn(),
});

const makeScholar = (overrides: Record<string, unknown> = {}) => ({
  profile_id: 11,
  user_id: 7,
  first_name: 'Juan',
  last_name: 'Dela Cruz',
  current_year_level: 2,
  scholarship_track: 'Academic Track',
  school_name: 'University of Mindanao',
  school_id: 1,
  student_number: '202300123',
  course_of_study: 'BSIT',
  phone_number: '09171234567',
  relative_employee: null,
  user: { user_id: 7, email: 'juan@example.com' },
  applications: [
    {
      application_id: 42,
      stage: 'Draft',
      status: 'PENDING',
      submitted_at: null,
    },
  ],
  documents: [{ document_id: 1, status: 'VERIFIED' }],
  ...overrides,
});

const makeDto = (overrides: Partial<CreateApplicationDto> = {}) =>
  ({
    scholarship_track: 'Academic Track',
    student_number: '202300123',
    student_address: 'Address',
    course_of_study: 'BSIT',
    school_name: 'University of Mindanao',
    school_address: 'Address',
    phone_number: '09171234567',
    relative_employee: '',
    current_year_level: 2,
    ...overrides,
  }) as CreateApplicationDto;

describe('ApplicationsService', () => {
  let service: ApplicationsService;
  let prisma: ReturnType<typeof createPrismaMock>;
  let audit: ReturnType<typeof createAuditMock>;
  let mail: ReturnType<typeof createMailMock>;
  let events: ReturnType<typeof createEventsMock>;
  let notifications: ReturnType<typeof createNotificationsMock>;
  let cache: ReturnType<typeof createCacheMock>;

  beforeEach(async () => {
    prisma = createPrismaMock();
    audit = createAuditMock();
    mail = createMailMock();
    events = createEventsMock();
    notifications = createNotificationsMock();
    cache = createCacheMock();

    prisma.scholarProfile.findUnique.mockResolvedValue(makeScholar());
    prisma.scholarProfile.findFirst.mockResolvedValue(null);
    prisma.scholarProfile.update.mockResolvedValue({});
    prisma.schoolGradingSystem.findFirst.mockResolvedValue(null);
    prisma.school.findFirst.mockResolvedValue({
      school_id: 1,
      school_name: 'University of Mindanao',
    });
    prisma.school.findUnique.mockResolvedValue({ school_id: 1 });
    prisma.school.create.mockResolvedValue({
      school_id: 2,
      school_name: 'University of Mindanao',
    });
    prisma.academicProgram.findFirst.mockResolvedValue({
      program_code: 'BSIT',
    });
    prisma.academicProgram.findUnique.mockResolvedValue(null);
    prisma.academicProgram.create.mockResolvedValue({ program_code: 'BSIT' });
    prisma.application.create.mockResolvedValue({
      application_id: 99,
      stage: 'Draft',
      status: 'PENDING',
    });
    prisma.application.update.mockResolvedValue({
      application_id: 42,
      stage: 'Submitted',
      status: 'PENDING',
      submitted_at: new Date('2026-08-01T00:00:00.000Z'),
    });
    prisma.gradeReport.findMany.mockResolvedValue([]);
    prisma.scholarDocument.findMany.mockResolvedValue([]);
    prisma.application.findMany.mockResolvedValue([]);
    prisma.application.findUnique.mockResolvedValue({
      application_id: 42,
      scholar_profile_id: 11,
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApplicationsService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: MailService, useValue: mail },
        { provide: EventsGateway, useValue: events },
        { provide: NotificationsService, useValue: notifications },
        { provide: AppCacheService, useValue: cache },
      ],
    }).compile();

    service = module.get<ApplicationsService>(ApplicationsService);
  });

  it('is created by the Nest testing module', () => {
    expect(service).toBeDefined();
  });

  describe('submitApplication', () => {
    it('throws NotFoundException when the scholar profile is missing', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue(null);

      await expect(service.submitApplication(7, makeDto())).rejects.toThrow(
        new NotFoundException('Scholar profile not found.'),
      );
    });

    it('rejects a student number that belongs to another applicant', async () => {
      prisma.scholarProfile.findFirst.mockResolvedValue({
        profile_id: 99,
        student_number: '202300123',
      });

      await expect(service.submitApplication(7, makeDto())).rejects.toThrow(
        new ConflictException(
          'Student number is already in use by another applicant.',
        ),
      );
      expect(prisma.scholarProfile.findFirst).toHaveBeenCalledWith({
        where: {
          student_number: '202300123',
          profile_id: { not: 11 },
        },
      });
    });

    it('rejects a phone number that belongs to another profile', async () => {
      prisma.scholarProfile.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ profile_id: 99, phone_number: '09171234567' });

      await expect(service.submitApplication(7, makeDto())).rejects.toThrow(
        new ConflictException(
          'Phone number is already in use by another profile.',
        ),
      );
    });

    it('rejects a relative employee who is already linked to another scholar', async () => {
      prisma.scholarProfile.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ profile_id: 99 });

      await expect(
        service.submitApplication(7, makeDto({ relative_employee: ' Maria ' })),
      ).rejects.toThrow(
        new ConflictException(
          'This relative employee is already associated with another scholar or applicant. The company policy permits only 1 scholar per employee.',
        ),
      );
    });

    it('reuses the matched grading school and creates no school record', async () => {
      prisma.schoolGradingSystem.findFirst.mockResolvedValue({
        school_id: 77,
        school_name: 'University of Mindanao',
      });

      await service.submitApplication(7, makeDto());

      expect(prisma.school.create).not.toHaveBeenCalled();
      expect(prisma.scholarProfile.update).toHaveBeenCalledWith({
        where: { profile_id: 11 },
        data: objectMatching({ school_id: 77 }),
      });
    });

    it('proposes a new school when it is unknown to both school tables', async () => {
      prisma.school.findFirst.mockResolvedValue(null);
      prisma.school.findUnique.mockResolvedValue(null);

      await service.submitApplication(7, makeDto());

      expect(prisma.school.create).toHaveBeenCalledWith({
        data: {
          school_name: 'University of Mindanao',
          school_code: 'UM',
          address: 'Address',
          is_active: false,
          grading_system_id: null,
        },
      });
      expect(cache.delPattern).toHaveBeenCalledWith('settings:schools_list:');
      expect(events.emitToAll).toHaveBeenCalledWith('school:created', {
        school_id: 2,
        school_name: 'University of Mindanao',
      });
      expect(notifications.createForRoles).toHaveBeenCalledWith(
        [Role.COORDINATOR, Role.GRANTOR, Role.ADMIN],
        objectMatching({
          title: 'New School Proposed',
          category: 'school',
        }),
      );
    });

    it('generates no school code when every candidate code is already taken', async () => {
      prisma.school.findFirst.mockResolvedValue(null);
      prisma.school.findUnique.mockResolvedValue({ school_id: 9 });

      await service.submitApplication(7, makeDto());

      expect(prisma.school.create).toHaveBeenCalledWith({
        data: objectMatching({ school_code: null }),
      });
    });

    it('proposes a new academic program when the course is unknown', async () => {
      prisma.academicProgram.findFirst.mockResolvedValue(null);
      prisma.academicProgram.findUnique.mockResolvedValue(null);
      prisma.academicProgram.create.mockResolvedValue({ program_code: 'BSIT' });

      await service.submitApplication(7, makeDto());

      expect(prisma.academicProgram.create).toHaveBeenCalledWith({
        data: {
          program_code: 'BSIT',
          program_name: 'BSIT',
          category: 'College',
          description: 'Proposed by applicant (Juan Dela Cruz)',
          is_active: false,
        },
      });
      expect(events.emitToAll).toHaveBeenCalledWith('program:created', {
        program_code: 'BSIT',
      });
      expect(notifications.createForRoles).toHaveBeenCalledWith(
        [Role.COORDINATOR, Role.GRANTOR, Role.ADMIN],
        objectMatching({ title: 'New Program Proposed' }),
      );
    });

    it('derives a program code from a plain word-prefixed course name', async () => {
      prisma.academicProgram.findFirst.mockResolvedValue(null);
      prisma.academicProgram.findUnique.mockResolvedValue(null);

      await service.submitApplication(
        7,
        makeDto({ course_of_study: 'BS in Computer Science' }),
      );

      expect(prisma.academicProgram.create).toHaveBeenCalledWith({
        data: objectMatching({ program_code: 'BSCS' }),
      });
    });

    it('derives a program code from an alias-prefixed course name', async () => {
      prisma.academicProgram.findFirst.mockResolvedValue(null);
      prisma.academicProgram.findUnique.mockResolvedValue(null);

      await service.submitApplication(
        7,
        makeDto({ course_of_study: 'AB in English' }),
      );

      expect(prisma.academicProgram.create).toHaveBeenCalledWith({
        data: objectMatching({ program_code: 'ABE' }),
      });
    });

    it('falls back to a truncated sanitized code for unusual course names', async () => {
      prisma.academicProgram.findFirst.mockResolvedValue(null);
      prisma.academicProgram.findUnique.mockResolvedValue(null);

      await service.submitApplication(7, makeDto({ course_of_study: 'AA' }));

      expect(prisma.academicProgram.create).toHaveBeenCalledWith({
        data: objectMatching({ program_code: 'AA' }),
      });
    });

    it('reuses the existing application when the scholar has one', async () => {
      prisma.application.create.mockResolvedValue(undefined);

      const result = await service.submitApplication(7, makeDto());

      expect(prisma.application.create).not.toHaveBeenCalled();
      expect(result.application_id).toBe(42);
    });

    it('creates a Draft application when none exists yet', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue(
        makeScholar({ applications: [] }),
      );

      const result = await service.submitApplication(
        7,
        makeDto({ school_name: 'Mindanao State University-IIT' }),
      );

      expect(prisma.application.create).toHaveBeenCalledWith({
        data: {
          scholar_profile_id: 11,
          stage: 'Draft',
          status: 'PENDING',
        },
      });
      expect(result.application_id).toBe(99);
    });

    it('audits a details save without firing submitted notifications when docs are unconfirmed', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue(
        makeScholar({
          documents: [{ document_id: 1, status: 'PENDING_REVIEW' }],
        }),
      );

      const result = await service.submitApplication(7, makeDto());

      expect(audit.log).toHaveBeenCalledWith(
        7,
        'APPLICATION_DETAILS_SAVED',
        'Scholar (User ID: 7) saved applicant details for application (ID: 42).',
      );
      expect(audit.log).not.toHaveBeenCalledWith(
        7,
        'APPLICATION_DETAILS_UPDATED',
        anyArg(String),
      );
      expect(result.application_id).toBe(42);
    });

    it('audits an update when documents are already confirmed', async () => {
      await service.submitApplication(7, makeDto());

      expect(audit.log).toHaveBeenCalledWith(
        7,
        'APPLICATION_DETAILS_UPDATED',
        'Scholar (User ID: 7) updated applicant details for application (ID: 42).',
      );
    });

    it('persists normalized details on the scholar profile', async () => {
      await service.submitApplication(
        7,
        makeDto({ current_year_level: undefined }),
      );

      expect(prisma.scholarProfile.update).toHaveBeenCalledWith({
        where: { profile_id: 11 },
        data: objectMatching({
          scholarship_track: 'Academic Track',
          course_of_study: 'BSIT',
          school_name: 'University of Mindanao',
          student_number: '202300123',
          current_year_level: 2,
        }),
      });
    });
  });

  describe('finalizeApplication', () => {
    it('throws NotFoundException when there is no scholar profile', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue(null);

      await expect(service.finalizeApplication(7)).rejects.toThrow(
        new NotFoundException(
          'No active application found. Please complete your applicant details first.',
        ),
      );
    });

    it('throws NotFoundException when the scholar has no applications', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue(
        makeScholar({ applications: [] }),
      );

      await expect(service.finalizeApplication(7)).rejects.toThrow(
        new NotFoundException(
          'No active application found. Please complete your applicant details first.',
        ),
      );
    });

    it('requires a confirmed document before submission', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue(
        makeScholar({
          documents: [{ document_id: 3, status: 'PENDING_REVIEW' }],
        }),
      );

      await expect(service.finalizeApplication(7)).rejects.toThrow(
        new BadRequestException(
          'Please upload and confirm your required document before submitting your application.',
        ),
      );
    });

    it('returns the existing application without re-notifying when already submitted', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue(
        makeScholar({
          applications: [
            {
              application_id: 42,
              stage: 'Submitted',
              status: 'PENDING',
              submitted_at: new Date('2026-06-01T00:00:00.000Z'),
            },
          ],
        }),
      );

      const result = await service.finalizeApplication(7);

      expect(result.application_id).toBe(42);
      expect(prisma.application.update).not.toHaveBeenCalled();
      expect(mail.sendApplicationSubmittedStudent).not.toHaveBeenCalled();
      expect(events.emitToStaff).not.toHaveBeenCalledWith(
        'application:submitted',
        anyArg(Object),
      );
    });

    it('marks a draft as Submitted and notifies the scholar and staff', async () => {
      const result = await service.finalizeApplication(7);

      expect(prisma.application.update).toHaveBeenCalledWith({
        where: { application_id: 42 },
        data: {
          stage: 'Submitted',
          status: 'PENDING',
          submitted_at: anyArg(Date),
        },
      });
      expect(audit.log).toHaveBeenCalledWith(
        7,
        'APPLICATION_SUBMITTED',
        'Scholar (User ID: 7) submitted application (ID: 42).',
      );
      expect(mail.sendApplicationSubmittedStudent).toHaveBeenCalledWith(
        'juan@example.com',
        objectMatching({ studentName: 'Juan Dela Cruz' }),
      );
      expect(events.emitToStaff).toHaveBeenCalledWith(
        'application:submitted',
        objectMatching({ applicationId: 42 }),
      );
      expect(notifications.notifyStaff).toHaveBeenCalledWith(
        objectMatching({ title: 'New Application Submitted' }),
      );
      expect(notifications.notifyUser).toHaveBeenCalledWith(
        7,
        objectMatching({ title: 'Application Submitted' }),
      );
      expect(result.application_id).toBe(42);
    });

    it('sends staff a submission email when staff emails are available', async () => {
      mail.getStaffEmails.mockResolvedValueOnce(['staff@example.com']);

      await service.finalizeApplication(7);
      await Promise.resolve();

      expect(mail.sendApplicationSubmittedStaff).toHaveBeenCalledWith(
        ['staff@example.com'],
        objectMatching({ studentName: 'Juan Dela Cruz' }),
      );
    });
  });

  describe('getMyApplication', () => {
    it('throws NotFoundException when the scholar has no application', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue(
        makeScholar({ applications: [] }),
      );

      await expect(service.getMyApplication(7)).rejects.toThrow(
        new NotFoundException('No active application found for this scholar.'),
      );
    });

    it("returns the scholar's single application", async () => {
      const result = await service.getMyApplication(7);

      expect(prisma.scholarProfile.findUnique).toHaveBeenCalledWith(
        objectMatching({
          where: { user_id: 7 },
          include: objectMatching({
            applications: anyArg(Object),
          }),
        }),
      );
      expect(result.application_id).toBe(42);
    });
  });

  describe('findAll', () => {
    it('excludes Draft applications and filters by status', async () => {
      await service.findAll({ status: 'PENDING' });

      expect(prisma.application.findMany).toHaveBeenCalledWith(
        objectMatching({
          where: { stage: { not: 'Draft' }, status: 'PENDING' },
        }),
      );
    });

    it('adds the scholar profile as an is relation when filtering by track or search', async () => {
      await service.findAll({ track: 'Academic' });

      expect(prisma.application.findMany).toHaveBeenCalledWith(
        objectMatching({
          where: objectMatching({
            scholar_profile: {
              is: { scholarship_track: 'Academic' },
            },
          }),
        }),
      );
    });

    it('uses insensitive search across name and student number', async () => {
      await service.findAll({ search: 'donna' });

      expect(prisma.application.findMany).toHaveBeenCalledWith(
        objectMatching({
          where: objectMatching({
            scholar_profile: {
              is: {
                OR: [
                  { first_name: { contains: 'donna', mode: 'insensitive' } },
                  { last_name: { contains: 'donna', mode: 'insensitive' } },
                  {
                    student_number: { contains: 'donna', mode: 'insensitive' },
                  },
                ],
              },
            },
          }),
        }),
      );
    });

    it('attaches the latest confirmed general average with source confirmed', async () => {
      prisma.application.findMany.mockResolvedValue([
        { application_id: 1, scholar_profile_id: 11, stage: 'Submitted' },
      ]);
      prisma.gradeReport.findMany.mockResolvedValue([
        { scholar_profile_id: 11, gpa: '1.75' },
      ]);
      prisma.scholarDocument.findMany.mockResolvedValue([
        {
          scholar_profile_id: 11,
          confirmed_data: { general_average: '1.5' },
        },
      ]);

      const [result] = await service.findAll({});

      expect(result).toEqual(
        objectMatching({
          general_average: 1.5,
          general_average_source: 'confirmed',
        }),
      );
    });

    it('falls back to the latest verified GPA when no confirmed average exists', async () => {
      prisma.application.findMany.mockResolvedValue([
        { application_id: 1, scholar_profile_id: 11, stage: 'Submitted' },
      ]);
      prisma.gradeReport.findMany.mockResolvedValue([
        { scholar_profile_id: 11, gpa: '1.75' },
      ]);
      prisma.scholarDocument.findMany.mockResolvedValue([
        { scholar_profile_id: 11, confirmed_data: {} },
      ]);

      const [result] = await service.findAll({});

      expect(result).toEqual(
        objectMatching({
          general_average: 1.75,
          general_average_source: 'verified',
        }),
      );
    });

    it('uses the first GPA report per scholar when several submissions exist', async () => {
      prisma.application.findMany.mockResolvedValue([
        { application_id: 1, scholar_profile_id: 11, stage: 'Submitted' },
      ]);
      prisma.gradeReport.findMany.mockResolvedValue([
        { scholar_profile_id: 11, gpa: '1.5' },
        { scholar_profile_id: 11, gpa: '2.5' },
      ]);

      const [result] = await service.findAll({});

      expect(result.general_average).toBe(1.5);
    });

    it('returns null general average when no grades are available', async () => {
      prisma.application.findMany.mockResolvedValue([
        { application_id: 1, scholar_profile_id: 11, stage: 'Submitted' },
      ]);

      const [result] = await service.findAll({});

      expect(result).toEqual(
        objectMatching({
          general_average: null,
          general_average_source: null,
        }),
      );
    });
  });

  describe('getApplicationDocuments', () => {
    it('throws NotFoundException when the application does not exist', async () => {
      prisma.application.findUnique.mockResolvedValue(null);

      await expect(service.getApplicationDocuments(99)).rejects.toThrow(
        new NotFoundException('Application ID 99 not found.'),
      );
    });

    it('returns the documents for the scholar behind the application', async () => {
      const docs = [{ document_id: 5, document_type: 'TOR' }];
      prisma.scholarDocument.findMany.mockResolvedValue(docs);

      const result = await service.getApplicationDocuments(42);

      expect(prisma.scholarDocument.findMany).toHaveBeenCalledWith(
        objectMatching({
          where: { scholar_profile_id: 11 },
          orderBy: { uploaded_at: 'desc' },
        }),
      );
      expect(result).toBe(docs);
    });
  });
});
