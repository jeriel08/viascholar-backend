import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DocumentConfirmationService } from './document-confirmation.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { MailService } from '../../mail/mail.service.js';
import { EventsGateway } from '../../events/events.gateway.js';
import { NotificationsService } from '../../notifications/notifications.service.js';
import type { ConfirmDocumentDto } from '../dto/confirm-document.dto.js';

const objectMatching = (shape: Record<string, unknown>) =>
  expect.objectContaining(shape) as Record<string, unknown>;
const stringMatching = (re: RegExp) => expect.stringMatching(re) as string;

const createPrismaMock = () => ({
  scholarDocument: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  gradeReport: {
    findFirst: vi.fn(),
  },
  termEnrollment: {
    findFirst: vi.fn(),
    update: vi.fn(),
  },
});

const createAuditMock = () => ({ log: vi.fn() });
const createMailMock = () => ({ sendDocumentActionRequired: vi.fn() });
const createEventsMock = () => ({
  emitToStaff: vi.fn(),
  emitToUser: vi.fn(),
});
const createNotificationsMock = () => ({
  notifyStaff: vi.fn(),
  notifyUser: vi.fn(),
});

const makeScholar = (overrides: Record<string, unknown> = {}) => ({
  profile_id: 11,
  user_id: 7,
  first_name: 'Juan',
  last_name: 'Dela Cruz',
  ...overrides,
});

const makeDoc = (overrides: Record<string, unknown> = {}) => ({
  document_id: 55,
  scholar_profile_id: 11,
  document_type: 'Form 138',
  label: 'Senior High School Report Card (Form 138 / Form 9)',
  status: 'PENDING',
  extracted_data: { student_name: 'Juan Dela Cruz' },
  confirmed_data: null,
  scholar_profile: {
    ...makeScholar(),
    user: { user_id: 7, email: 'juan@example.com', role: 'SCHOLAR' },
  },
  ...overrides,
});

const makeEnrollment = (overrides: Record<string, unknown> = {}) => ({
  enrollment_id: 50,
  scholar_profile_id: 11,
  status: 'APPROVED',
  academic_year: '2026-2027',
  semester: '1st Semester',
  enrolled_subjects: [
    { subject_code: 'IT 101', descriptive_title: 'Intro to IT', units: 3 },
    { subject_code: 'GE 101', descriptive_title: 'Nat Sci', units: 2 },
  ],
  coordinator_notes: null,
  ...overrides,
});

const makeConfirmDto = (
  overrides: Record<string, unknown> = {},
): ConfirmDocumentDto => ({
  grade_items: [
    {
      subject_code: 'IT 101',
      subject_name: 'Intro to IT',
      units: 3,
      grade: 1.5,
    },
    {
      subject_code: 'GE 101',
      subject_name: 'Nat Sci',
      units: 2,
      grade: 1.75,
    },
  ],
  ...overrides,
});

describe('DocumentConfirmationService', () => {
  let service: DocumentConfirmationService;
  let prisma: ReturnType<typeof createPrismaMock>;
  let audit: ReturnType<typeof createAuditMock>;
  let mail: ReturnType<typeof createMailMock>;
  let events: ReturnType<typeof createEventsMock>;
  let notifications: ReturnType<typeof createNotificationsMock>;

  beforeEach(async () => {
    prisma = createPrismaMock();
    audit = createAuditMock();
    mail = createMailMock();
    events = createEventsMock();
    notifications = createNotificationsMock();

    prisma.scholarDocument.findUnique.mockResolvedValue(makeDoc());
    prisma.scholarDocument.update.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...makeDoc(), ...data }),
    );
    prisma.gradeReport.findFirst.mockResolvedValue(null);
    prisma.termEnrollment.findFirst.mockResolvedValue(makeEnrollment());
    prisma.termEnrollment.update.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...makeEnrollment(), ...data }),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DocumentConfirmationService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: MailService, useValue: mail },
        { provide: EventsGateway, useValue: events },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();

    service = module.get<DocumentConfirmationService>(
      DocumentConfirmationService,
    );
  });

  it('is created by the Nest testing module', () => {
    expect(service).toBeDefined();
  });

  describe('confirmDocument', () => {
    it('throws NotFoundException when the document is missing', async () => {
      prisma.scholarDocument.findUnique.mockResolvedValue(null);

      await expect(
        service.confirmDocument(7, 55, makeConfirmDto()),
      ).rejects.toThrow(new NotFoundException('Document ID 55 not found.'));
    });

    it('throws NotFoundException when the document belongs to someone else', async () => {
      prisma.scholarDocument.findUnique.mockResolvedValue(
        makeDoc({
          scholar_profile: {
            ...makeScholar(),
            user_id: 99,
            user: { user_id: 99, email: 'x@y.z', role: 'SCHOLAR' },
          },
        }),
      );

      await expect(
        service.confirmDocument(7, 55, makeConfirmDto()),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException when the document is not PENDING or PASSED_PRECHECK', async () => {
      prisma.scholarDocument.findUnique.mockResolvedValue(
        makeDoc({ status: 'STUDENT_CONFIRMED' }),
      );

      await expect(
        service.confirmDocument(7, 55, makeConfirmDto()),
      ).rejects.toThrow(
        new BadRequestException(
          "Document ID 55 cannot be confirmed while in 'STUDENT_CONFIRMED' status.",
        ),
      );
    });

    it('names the mismatched academic year for a CCG against the enrolled AY', async () => {
      prisma.scholarDocument.findUnique.mockResolvedValue(
        makeDoc({ document_type: 'CCG' }),
      );

      await expect(
        service.confirmDocument(
          7,
          55,
          makeConfirmDto({ academic_year: '2025-2026' }),
        ),
      ).rejects.toThrow(/CCG is for AY 2025-2026/);
    });

    it('names the mismatched semester for a CCG against the enrolled term', async () => {
      prisma.scholarDocument.findUnique.mockResolvedValue(
        makeDoc({ document_type: 'CCG' }),
      );

      await expect(
        service.confirmDocument(
          7,
          55,
          makeConfirmDto({ semester: '2nd Semester' }),
        ),
      ).rejects.toThrow(/CCG is for 2nd Semester/);
    });

    it('rejects a CCG when the grade report is flagged and waiting for the grantor', async () => {
      prisma.scholarDocument.findUnique.mockResolvedValue(
        makeDoc({ document_type: 'CCG' }),
      );
      prisma.gradeReport.findFirst.mockResolvedValue({
        report_id: 42,
        appeal_status: 'PENDING_GRANTOR',
      });

      await expect(
        service.confirmDocument(7, 55, makeConfirmDto()),
      ).rejects.toThrow(
        new BadRequestException(
          "Grade submission is paused while your academic appeal is awaiting the Grantor's verdict.",
        ),
      );
    });

    it('rejects a CCG when the appeal was DENIED', async () => {
      prisma.scholarDocument.findUnique.mockResolvedValue(
        makeDoc({ document_type: 'CCG' }),
      );
      prisma.gradeReport.findFirst.mockResolvedValue({
        report_id: 42,
        appeal_status: 'DENIED',
      });

      await expect(
        service.confirmDocument(7, 55, makeConfirmDto()),
      ).rejects.toThrow(
        new BadRequestException(
          'Grade submission is unavailable because your scholarship was discontinued.',
        ),
      );
    });

    it('rejects a CCG when the enrollment is not approved', async () => {
      prisma.scholarDocument.findUnique.mockResolvedValue(
        makeDoc({ document_type: 'CCG' }),
      );
      prisma.termEnrollment.findFirst.mockResolvedValue(
        makeEnrollment({ status: 'PENDING_REVIEW' }),
      );

      await expect(
        service.confirmDocument(7, 55, makeConfirmDto()),
      ).rejects.toThrow(
        new BadRequestException(
          'You cannot confirm or submit grades without an approved start-of-term enrollment.',
        ),
      );
    });

    it('rejects a CCG with subjects missing from the approved enrollment', async () => {
      prisma.scholarDocument.findUnique.mockResolvedValue(
        makeDoc({ document_type: 'CCG' }),
      );

      await expect(
        service.confirmDocument(
          7,
          55,
          makeConfirmDto({
            grade_items: [
              {
                subject_code: 'ZZ 999',
                subject_name: 'Random',
                units: 3,
                grade: 1.5,
              },
            ],
          }),
        ),
      ).rejects.toThrow(/Course\(s\) not in approved enrollment: ZZ 999/);
    });

    it('rejects a CCG when an enrolled course has no numeric grade', async () => {
      prisma.scholarDocument.findUnique.mockResolvedValue(
        makeDoc({ document_type: 'CCG' }),
      );

      await expect(
        service.confirmDocument(
          7,
          55,
          makeConfirmDto({
            grade_items: [
              {
                subject_code: 'IT 101',
                subject_name: 'Intro to IT',
                units: 3,
                grade: 0,
              },
              {
                subject_code: 'GE 101',
                subject_name: 'Nat Sci',
                units: 2,
                grade: 1.75,
              },
            ],
          }),
        ),
      ).rejects.toThrow(/Course\(s\) missing valid numeric grade: IT 101/);
    });

    it('rejects a CCG when an enrolled course is missing entirely', async () => {
      prisma.scholarDocument.findUnique.mockResolvedValue(
        makeDoc({ document_type: 'CCG' }),
      );

      await expect(
        service.confirmDocument(
          7,
          55,
          makeConfirmDto({
            grade_items: [
              {
                subject_code: 'IT 101',
                subject_name: 'Intro to IT',
                units: 3,
                grade: 1.5,
              },
            ],
          }),
        ),
      ).rejects.toThrow(/Missing enrolled course\(s\): GE 101/);
    });

    it('normalizes roman numerals in subject codes for the subject match', async () => {
      prisma.scholarDocument.findUnique.mockResolvedValue(
        makeDoc({ document_type: 'CCG' }),
      );
      prisma.termEnrollment.findFirst.mockResolvedValue(
        makeEnrollment({
          enrolled_subjects: [
            {
              subject_code: 'CS III',
              descriptive_title: 'Data Struc',
              units: 3,
            },
          ],
        }),
      );

      const result = await service.confirmDocument(
        7,
        55,
        makeConfirmDto({
          grade_items: [
            {
              subject_code: 'CS 3',
              subject_name: 'Data Struc',
              units: 3,
              grade: 1.75,
            },
          ],
        }),
      );

      expect(result.status).toBe('STUDENT_CONFIRMED');
    });

    it('rejects a name mismatch for TOR / CCG / Form 138 documents', async () => {
      prisma.scholarDocument.findUnique.mockResolvedValue(
        makeDoc({
          document_type: 'TOR',
          extracted_data: { student_name: 'Completely Different Person' },
        }),
      );

      await expect(
        service.confirmDocument(7, 55, makeConfirmDto()),
      ).rejects.toThrow(BadRequestException);
    });

    it('persists the confirmed data and emits events and notifications for scholar grade docs', async () => {
      prisma.scholarDocument.findUnique.mockResolvedValue(
        makeDoc({ document_type: 'CCG' }),
      );

      await service.confirmDocument(7, 55, makeConfirmDto());

      const updateCall = prisma.scholarDocument.update.mock.calls[0][0] as {
        data: { status: string; confirmed_data: Record<string, unknown> };
      };
      expect(updateCall.data.status).toBe('STUDENT_CONFIRMED');
      expect(updateCall.data.confirmed_data.academic_year).toBe('2026-2027');
      expect(updateCall.data.confirmed_data.semester).toBe('1st Semester');
      expect(updateCall.data.confirmed_data.grade_items).toHaveLength(2);
      expect(audit.log).toHaveBeenCalledWith(
        7,
        'DOCUMENT_CONFIRMED',
        expect.stringContaining('2 items'),
      );
      expect(events.emitToStaff).toHaveBeenCalledWith(
        'document:confirmed_by_applicant',
        objectMatching({ documentId: 55, documentType: 'CCG' }),
      );
      expect(events.emitToStaff).toHaveBeenCalledWith(
        'grade_report:submitted',
        objectMatching({ documentId: 55 }),
      );
      expect(notifications.notifyStaff).toHaveBeenCalledWith(
        objectMatching({ title: 'New Grade Audit Awaiting Review' }),
      );
    });

    it('marks the CCG enrollment COMPLETED with a coordinator note', async () => {
      prisma.scholarDocument.findUnique.mockResolvedValue(
        makeDoc({ document_type: 'CCG' }),
      );

      await service.confirmDocument(7, 55, makeConfirmDto());

      expect(prisma.termEnrollment.update).toHaveBeenCalledWith({
        where: { enrollment_id: 50 },
        data: objectMatching({
          status: 'COMPLETED',
          coordinator_notes: stringMatching(
            /Semester concluded with CCG submission/,
          ),
        }),
      });
      expect(events.emitToUser).toHaveBeenCalledWith(
        7,
        'enrollment:updated',
        objectMatching({ status: 'COMPLETED' }),
      );
    });

    it('appends to existing coordinator notes when present', async () => {
      prisma.scholarDocument.findUnique.mockResolvedValue(
        makeDoc({ document_type: 'CCG' }),
      );
      prisma.termEnrollment.findFirst.mockResolvedValue(
        makeEnrollment({ coordinator_notes: 'Prior note' }),
      );

      await service.confirmDocument(7, 55, makeConfirmDto());

      const call = prisma.termEnrollment.update.mock.calls[0][0] as {
        data: { coordinator_notes: string };
      };
      expect(call.data.coordinator_notes).toBe(
        'Prior note | Semester concluded with CCG submission.',
      );
    });

    it('uses the generic staff notification for non-grade documents', async () => {
      prisma.scholarDocument.findUnique.mockResolvedValue(
        makeDoc({ document_type: 'Form 138' }),
      );

      await service.confirmDocument(7, 55, makeConfirmDto());

      expect(events.emitToStaff).toHaveBeenCalledTimes(1);
      expect(events.emitToStaff).not.toHaveBeenCalledWith(
        'grade_report:submitted',
        expect.any(Object),
      );
      expect(notifications.notifyStaff).toHaveBeenCalledWith(
        objectMatching({ title: 'Documents Confirmed' }),
      );
    });

    it('falls back to the extracted grades when no grade items are sent and computes general average from DTO when given', async () => {
      const dto = {
        general_average: 1.5,
      } as ConfirmDocumentDto;
      prisma.scholarDocument.findUnique.mockResolvedValue(
        makeDoc({
          extracted_data: {
            student_name: 'Juan Dela Cruz',
            grades: [
              {
                subject_code: 'Math 1',
                subject_name: 'Math',
                units: 3,
                grade: 1.25,
              },
              {
                subject_code: 'Write',
                subject_name: 'Writing',
                units: 2,
                grade: 'PSD',
              },
            ],
          },
        }),
      );

      const result = await service.confirmDocument(7, 55, dto);

      const updateCall = prisma.scholarDocument.update.mock.calls[0][0] as {
        data: {
          confirmed_data: {
            general_average: number;
            grade_items: Array<Record<string, unknown>>;
          };
        };
      };
      expect(updateCall.data.confirmed_data.general_average).toBe(1.5);
      expect(updateCall.data.confirmed_data.grade_items).toHaveLength(1);
      expect(result.status).toBe('STUDENT_CONFIRMED');
    });
  });

  describe('requestChanges', () => {
    it('throws NotFoundException when the document does not exist', async () => {
      prisma.scholarDocument.findUnique.mockResolvedValue(null);

      await expect(service.requestChanges(7, 55, 'Blurry')).rejects.toThrow(
        new NotFoundException('Document ID 55 not found.'),
      );
    });

    it('updates the document, emails the scholar, and notifies staff and user', async () => {
      await service.requestChanges(7, 55, 'Blurry photo');

      expect(prisma.scholarDocument.update).toHaveBeenCalledWith({
        where: { document_id: 55 },
        data: objectMatching({
          status: 'NEEDS_REUPLOAD',
          rejection_reason: 'Blurry photo',
        }),
      });
      expect(audit.log).toHaveBeenCalledWith(
        7,
        'DOCUMENT_CHANGES_REQUESTED',
        stringMatching(/Blurry photo/),
      );
      expect(mail.sendDocumentActionRequired).toHaveBeenCalledWith(
        'juan@example.com',
        objectMatching({ reason: 'Blurry photo' }),
      );
      expect(events.emitToStaff).toHaveBeenCalledWith(
        'document:changes_requested',
        objectMatching({ reason: 'Blurry photo' }),
      );
      expect(events.emitToUser).toHaveBeenCalledWith(
        7,
        'document:changes_requested',
        objectMatching({ reason: 'Blurry photo' }),
      );
      expect(notifications.notifyUser).toHaveBeenCalledWith(
        7,
        objectMatching({ title: 'Document Revision Needed' }),
      );
      expect(notifications.notifyStaff).toHaveBeenCalledWith(
        objectMatching({ title: 'Document Revision Requested' }),
      );
    });

    it('skips the email and user events when the student has no linked user', async () => {
      prisma.scholarDocument.findUnique.mockResolvedValue(
        makeDoc({
          scholar_profile: {
            ...makeScholar({ user_id: null as unknown as number }),
            user: null,
          },
        }),
      );

      await service.requestChanges(7, 55, 'Blurry photo');

      expect(mail.sendDocumentActionRequired).not.toHaveBeenCalled();
      expect(events.emitToUser).not.toHaveBeenCalled();
      expect(notifications.notifyUser).not.toHaveBeenCalled();
      expect(events.emitToStaff).toHaveBeenCalled();
    });
  });
});
