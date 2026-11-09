import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DocumentEvaluationService } from './document-evaluation.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { SettingsService } from '../../settings/settings.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { GradeCalculatorService } from './grade-calculator.service.js';
import { ProspectusTransitionService } from './prospectus-transition.service.js';
import { DocumentConfirmationService } from './document-confirmation.service.js';
import { EventsGateway } from '../../events/events.gateway.js';
import { NotificationsService } from '../../notifications/notifications.service.js';
import type { VerifyDocumentDto } from '../dto/verify-document.dto.js';

const objectMatching = (shape: Record<string, unknown>) =>
  expect.objectContaining(shape) as Record<string, unknown>;

const createPrismaMock = () => ({
  employee: {
    findUnique: vi.fn(),
  },
  scholarDocument: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  termEnrollment: {
    findMany: vi.fn(),
    update: vi.fn(),
  },
  schoolGradingSystem: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
  },
  gradeReport: {
    create: vi.fn(),
  },
});

const createAuditMock = () => ({ log: vi.fn() });
const createSettingsMock = () => ({
  getSettings: vi.fn().mockResolvedValue({ grade_threshold: 75 }),
  evaluateGwaThreshold: vi.fn().mockReturnValue(true),
  evaluateStudentGrade: vi.fn().mockReturnValue({ isPassing: true }),
});
const createGradeCalcMock = () => ({
  isForm138: vi.fn().mockReturnValue(false),
  computeGwa: vi.fn().mockReturnValue({
    computedGwa: 1.5,
    hasFailedGrade: false,
    totalUnits: 5,
  }),
  normalizeAcademicYear: vi.fn().mockReturnValue('2026-2027'),
  normalizeSemester: vi.fn().mockReturnValue('1st Semester'),
});
const createProspectusMock = () => ({
  transitionProspectusSubjects: vi.fn().mockResolvedValue(undefined),
  checkOnboardingApplication: vi.fn().mockResolvedValue(null),
});
const createConfirmationMock = () => ({
  confirmDocument: vi.fn(),
  requestChanges: vi.fn(),
});
const createEventsMock = () => ({
  emitToStaff: vi.fn(),
  emitToUser: vi.fn(),
});
const createNotificationsMock = () => ({
  notifyUser: vi.fn(),
  notifyStaff: vi.fn(),
});

const makeDoc = (overrides: Record<string, unknown> = {}) => ({
  document_id: 55,
  scholar_profile_id: 11,
  document_type: 'CCG',
  label: 'Certified Copy of Grades (CCG)',
  status: 'STUDENT_CONFIRMED',
  confirmed_data: {
    academic_year: '2026-2027',
    semester: '1st Semester',
    general_average: 1.5,
    grade_items: [
      { subject_code: 'IT 101', subject_name: 'Intro', units: 3, grade: 1.5 },
    ],
  },
  extracted_data: {
    academic_year: '2026-2027',
    semester: '1st Semester',
    school_name: 'University of Mindanao',
    grades: [
      { subject_code: 'IT 101', subject_name: 'Intro', units: 3, grade: 1.5 },
    ],
  },
  scholar_profile: {
    profile_id: 11,
    user_id: 7,
    first_name: 'Juan',
    last_name: 'Dela Cruz',
    school_id: 3,
    school_name: 'University of Mindanao',
    user: { user_id: 7, role: 'SCHOLAR' },
  },
  ...overrides,
});

const makeDto = (
  overrides: Record<string, unknown> = {},
): VerifyDocumentDto => ({ ...overrides });

describe('DocumentEvaluationService', () => {
  let service: DocumentEvaluationService;
  let prisma: ReturnType<typeof createPrismaMock>;
  let audit: ReturnType<typeof createAuditMock>;
  let settings: ReturnType<typeof createSettingsMock>;
  let gradeCalc: ReturnType<typeof createGradeCalcMock>;
  let prospectus: ReturnType<typeof createProspectusMock>;
  let confirmation: ReturnType<typeof createConfirmationMock>;
  let events: ReturnType<typeof createEventsMock>;
  let notifications: ReturnType<typeof createNotificationsMock>;

  beforeEach(async () => {
    prisma = createPrismaMock();
    audit = createAuditMock();
    settings = createSettingsMock();
    gradeCalc = createGradeCalcMock();
    prospectus = createProspectusMock();
    confirmation = createConfirmationMock();
    events = createEventsMock();
    notifications = createNotificationsMock();

    prisma.employee.findUnique.mockResolvedValue({
      employee_id: 201,
      first_name: 'Cora',
      last_name: 'Coordinator',
    });
    prisma.scholarDocument.findUnique.mockResolvedValue(makeDoc());
    prisma.scholarDocument.update.mockResolvedValue({});
    prisma.schoolGradingSystem.findUnique.mockResolvedValue(null);
    prisma.schoolGradingSystem.findFirst.mockResolvedValue(null);
    prisma.termEnrollment.findMany.mockResolvedValue([
      {
        enrollment_id: 50,
        scholar_profile_id: 11,
        status: 'APPROVED',
        academic_year: '2026-2027',
        semester: '1st Semester',
      },
    ]);
    prisma.termEnrollment.update.mockResolvedValue({});
    prisma.gradeReport.create.mockImplementation(
      ({
        data,
      }: {
        data: {
          grade_items?: { create: unknown[] };
          [key: string]: unknown;
        };
      }) =>
        Promise.resolve({
          report_id: 71,
          ...data,
          grade_items: data.grade_items?.create ?? [],
        }),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DocumentEvaluationService,
        { provide: PrismaService, useValue: prisma },
        { provide: SettingsService, useValue: settings },
        { provide: AuditService, useValue: audit },
        { provide: GradeCalculatorService, useValue: gradeCalc },
        { provide: ProspectusTransitionService, useValue: prospectus },
        { provide: DocumentConfirmationService, useValue: confirmation },
        { provide: EventsGateway, useValue: events },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();

    service = module.get<DocumentEvaluationService>(DocumentEvaluationService);
  });

  it('is created by the Nest testing module', () => {
    expect(service).toBeDefined();
  });

  describe('confirmDocument / requestChanges', () => {
    it('delegates confirmDocument to the confirmation service', () => {
      const dto = { general_average: 1.5 } as never;
      void service.confirmDocument(7, 55, dto);

      expect(confirmation.confirmDocument).toHaveBeenCalledWith(7, 55, dto);
    });

    it('delegates requestChanges with the reason from the DTO', () => {
      void service.requestChanges(7, 55, 'Blurry');

      expect(confirmation.requestChanges).toHaveBeenCalledWith(7, 55, 'Blurry');
    });
  });

  describe('verifyAndEvaluate', () => {
    it('throws NotFoundException when the coordinator is not an employee', async () => {
      prisma.employee.findUnique.mockResolvedValue(null);

      await expect(service.verifyAndEvaluate(7, 55, makeDto())).rejects.toThrow(
        new NotFoundException('Employee profile not found for current user.'),
      );
    });

    it('throws NotFoundException when the document does not exist', async () => {
      prisma.scholarDocument.findUnique.mockResolvedValue(null);

      await expect(service.verifyAndEvaluate(7, 55, makeDto())).rejects.toThrow(
        new NotFoundException('Document ID 55 not found.'),
      );
    });

    it('throws BadRequestException unless the document is STUDENT_CONFIRMED', async () => {
      prisma.scholarDocument.findUnique.mockResolvedValue(
        makeDoc({ status: 'PENDING' }),
      );

      await expect(service.verifyAndEvaluate(7, 55, makeDto())).rejects.toThrow(
        new BadRequestException(
          'Cannot verify document: Student must confirm first (status: PENDING).',
        ),
      );
    });

    it('throws BadRequestException when there are no grade items anywhere', async () => {
      prisma.scholarDocument.findUnique.mockResolvedValue(
        makeDoc({ extracted_data: {} }),
      );
      prisma.scholarDocument.findUnique.mockResolvedValue(
        makeDoc({ confirmed_data: null, extracted_data: {} }),
      );

      await expect(service.verifyAndEvaluate(7, 55, makeDto())).rejects.toThrow(
        new BadRequestException('No grade items available for this document.'),
      );
    });

    it('prefers grade items from the DTO over confirmed and extracted data', async () => {
      await service.verifyAndEvaluate(
        7,
        55,
        makeDto({
          grade_items: [
            {
              subject_code: 'DTO 1',
              subject_name: 'DtoOne',
              units: 1,
              grade: 2.0,
            },
          ],
        }),
      );

      expect(gradeCalc.computeGwa).toHaveBeenCalledWith(
        expect.objectContaining({
          gradeItems: [expect.objectContaining({ subject_code: 'DTO 1' })],
        }),
      );
    });

    it('throws BadRequestException when the CCG term does not match an approved enrollment', async () => {
      prisma.termEnrollment.findMany.mockResolvedValue([
        {
          enrollment_id: 51,
          status: 'PENDING_REVIEW',
          academic_year: '2026-2027',
          semester: '1st Semester',
        },
      ]);

      await expect(service.verifyAndEvaluate(7, 55, makeDto())).rejects.toThrow(
        /enrollment is not approved/,
      );
    });

    it('throws BadRequestException when no enrollment exists for the CCG term', async () => {
      prisma.termEnrollment.findMany.mockResolvedValue([]);

      await expect(service.verifyAndEvaluate(7, 55, makeDto())).rejects.toThrow(
        BadRequestException,
      );
    });

    it('computes the GWA and creates an APPROVED grade report for an eligible student', async () => {
      const result = await service.verifyAndEvaluate(7, 55, makeDto());

      expect(prisma.gradeReport.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: objectMatching({
            scholar_profile_id: 11,
            document_id: 55,
            academic_year: '2026-2027',
            semester: '1st Semester',
            gpa: 1.5,
            status: 'APPROVED',
            is_eligible: true,
            evaluation_flag: 'CLEARED',
            reviewed_by_employee_id: 201,
            term_enrollment_id: 50,
          }),
        }),
      );
      expect(prisma.scholarDocument.update).toHaveBeenCalledWith({
        where: { document_id: 55 },
        data: objectMatching({
          status: 'VERIFIED',
          reviewed_by_employee_id: 201,
        }),
      });
      expect(prospectus.transitionProspectusSubjects).toHaveBeenCalledWith(
        11,
        expect.any(Array),
        '2026-2027',
        '1st Semester',
        null,
      );
      expect(prisma.termEnrollment.update).toHaveBeenCalledWith({
        where: { enrollment_id: 50 },
        data: objectMatching({
          status: 'COMPLETED',
          coordinator_notes: expect.stringContaining(
            'Term grades verified',
          ) as unknown,
        }),
      });
      expect(audit.log).toHaveBeenCalledWith(
        7,
        'DOCUMENT_VERIFIED',
        expect.stringContaining('Eligible: true'),
      );
      expect(result.isEligible).toBe(true);
      expect(result.evaluationFlag).toBe('CLEARED');
    });

    it('omits the enrolled-term COMPLETED transition when the student is not eligible', async () => {
      gradeCalc.computeGwa.mockReturnValue({
        computedGwa: 4.5,
        hasFailedGrade: true,
        totalUnits: 5,
      });
      settings.evaluateGwaThreshold.mockReturnValue(false);

      const result = await service.verifyAndEvaluate(7, 55, makeDto());

      expect(prisma.termEnrollment.update).not.toHaveBeenCalled();
      expect(result.isEligible).toBe(false);
      expect(result.evaluationFlag).toBe('BELOW_PASSING_MARK');
      expect(prisma.gradeReport.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: objectMatching({ status: 'FLAGGED', is_eligible: false }),
        }),
      );
    });

    it('emits staff and user events with the verification payload', async () => {
      await service.verifyAndEvaluate(7, 55, makeDto());

      expect(events.emitToStaff).toHaveBeenCalledWith(
        'document:verified',
        objectMatching({ documentId: 55, reportId: 71 }),
      );
      expect(events.emitToStaff).toHaveBeenCalledWith(
        'grade_report:verified',
        objectMatching({ documentId: 55 }),
      );
      expect(events.emitToUser).toHaveBeenCalledWith(
        7,
        'document:verified',
        objectMatching({ documentId: 55 }),
      );
      expect(events.emitToUser).toHaveBeenCalledWith(
        7,
        'grade_report:verified',
        objectMatching({ documentId: 55 }),
      );
      expect(events.emitToUser).toHaveBeenCalledWith(
        7,
        'baseline:prospectus_processed',
        objectMatching({ documentId: 55 }),
      );
      expect(notifications.notifyUser).toHaveBeenCalledWith(
        7,
        objectMatching({
          title: 'Documents Verified',
          message: 'Your grade report has been verified by the coordinator.',
          link: '/ScholarGrade',
        }),
      );
      expect(notifications.notifyStaff).toHaveBeenCalledWith(
        objectMatching({ title: 'Documents Verified' }),
      );
    });

    it('uses the applicant message and link for a non-scholar grade document', async () => {
      prisma.scholarDocument.findUnique.mockResolvedValue(
        makeDoc({
          scholar_profile: {
            profile_id: 11,
            user_id: 7,
            first_name: 'Ana',
            last_name: 'Santos',
            school_id: 3,
            school_name: 'UM',
            user: { user_id: 7, role: 'APPLICANT' },
          },
        }),
      );

      await service.verifyAndEvaluate(7, 55, makeDto());

      expect(notifications.notifyUser).toHaveBeenCalledWith(
        7,
        objectMatching({
          title: 'Documents Verified',
          message:
            'Your documents have been verified! Your application is now Under Review.',
          link: '/ApplicantsApplication',
        }),
      );
    });

    it('falls back to the confirmed average when neither grade_items nor extracted grades include numbers', async () => {
      // gradeItems derives from dto -> confirmed -> extracted; all empty here,
      // and no explicit general average means computeGwa still runs on an
      // empty confirmed source is impossible, so rely on provided grade_items.
      prisma.scholarDocument.findUnique.mockResolvedValue(
        makeDoc({ confirmed_data: null }),
      );

      await service.verifyAndEvaluate(
        7,
        55,
        makeDto({
          grade_items: [
            { subject_code: 'X', subject_name: 'X', units: 1, grade: 2.0 },
          ],
        }),
      );

      expect(gradeCalc.computeGwa).toHaveBeenCalled();
    });

    it('resolves the school config from the profile school_id', async () => {
      prisma.schoolGradingSystem.findUnique.mockResolvedValue({
        school_id: 3,
        school_name: 'UM',
        grading_scale: 'NUMERIC_4_POINT',
      });

      await service.verifyAndEvaluate(7, 55, makeDto());

      expect(prisma.schoolGradingSystem.findUnique).toHaveBeenCalledWith({
        where: { school_id: 3 },
      });
    });

    it('uses no school config for Form 138 documents', async () => {
      gradeCalc.isForm138.mockReturnValue(true);

      await service.verifyAndEvaluate(7, 55, makeDto());

      expect(prisma.schoolGradingSystem.findUnique).not.toHaveBeenCalled();
      expect(prisma.schoolGradingSystem.findFirst).not.toHaveBeenCalled();
      expect(prospectus.transitionProspectusSubjects).toHaveBeenCalledWith(
        11,
        expect.any(Array),
        '2026-2027',
        '1st Semester',
        null,
      );
    });
  });
});
