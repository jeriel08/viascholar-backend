import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ScholarEnrollmentService } from './scholar-enrollment.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { EventsGateway } from '../../events/events.gateway.js';
import { CloudinaryService } from '../../cloudinary/cloudinary.service.js';
import { EnrollmentOcrService } from './enrollment-ocr.service.js';
import { EnrollmentAuditEngineService } from './enrollment-audit-engine.service.js';
import type { SubmitEnrollmentDto } from '../dto/submit-enrollment.dto.js';

// Asymmetric matchers are untyped; cast once so nested properties satisfy the linter.
const objectMatching = (shape: Record<string, unknown>) =>
  expect.objectContaining(shape) as Record<string, unknown>;

const makeFile = (
  size = 1024,
  name = 'cor.pdf',
  mimetype = 'application/pdf',
): Express.Multer.File =>
  ({
    originalname: name,
    mimetype,
    size,
    buffer: Buffer.from('file-content'),
  }) as Express.Multer.File;

const makeSubmitDto = (
  overrides: Record<string, unknown> = {},
): SubmitEnrollmentDto => ({
  academic_year: '2026-2027',
  semester: '1st Semester',
  year_level: 2,
  is_consolidated: false,
  cor_document_id: 77,
  soa_document_id: 88,
  total_units: 15,
  total_assessment: 12000,
  assessment_date: '2026-06-01T00:00:00.000Z',
  enrolled_subjects: [
    { subject_code: 'IT 101', descriptive_title: 'Intro to IT', units: 3 },
  ],
  billing_breakdown: { tuition_fee: 9000, net_balance_due: 12000 },
  ...overrides,
});

const scholar = {
  profile_id: 10,
  user_id: 3,
  first_name: 'Ana',
  last_name: 'Cruz',
  current_year_level: 2,
  prospectus: { prospectus_id: 55, is_frozen: true, subjects: [] },
  school_grading_system: null,
};

const extractedCor = {
  student_name: 'Ana Cruz',
  student_number: '2020-001',
  school_name: 'UM',
  course_name: 'BSIT',
  academic_year: '2026-2027',
  semester: '1st Semester',
  year_level: 2,
  total_units: 15,
  subjects: [
    { subject_code: 'IT 101', descriptive_title: 'Intro to IT', units: 3 },
  ],
};

const extractedSoa = {
  student_name: 'Ana Cruz',
  student_number: '2020-001',
  academic_year: '2026-2027',
  semester: '2nd Semester',
  assessment_date: '2026-06-01T00:00:00.000Z',
  total_assessment: 12000,
  tuition_fee: '9000',
  lab_fees: 1500,
  misc_fees: null,
  other_fees: undefined,
  previous_balance: 0,
  discounts: 500,
  net_balance_due: 11000,
};

const extractedConsolidated = {
  ...extractedCor,
  total_units: 7,
  subjects: [
    { subject_code: 'IT 101', descriptive_title: 'Intro to IT', units: 3 },
    { subject_code: 'IT 102', descriptive_title: 'Programming 1', units: 4 },
  ],
  assessment_date: '2026-06-01T00:00:00.000Z',
  total_assessment: 15000,
  tuition_fee: 10000,
  lab_fees: 2500,
  misc_fees: 500,
  other_fees: 1000,
  previous_balance: 250,
  discounts: 750,
  net_balance_due: 13500,
};

const auditResult = {
  all_cleared: true,
  flags: ['UNDERLOAD_UNITS'],
  total_units: 15,
  subjects_audit: [],
  cross_doc_reconciliation: {
    is_match: true,
    confidence_score: 100,
    mismatches: [],
  },
};

describe('ScholarEnrollmentService', () => {
  let service: ScholarEnrollmentService;
  let prisma: {
    scholarProfile: { findUnique: ReturnType<typeof vi.fn> };
    gradeReport: { findFirst: ReturnType<typeof vi.fn> };
    termEnrollment: {
      findFirst: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
      upsert: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      delete: ReturnType<typeof vi.fn>;
      deleteMany: ReturnType<typeof vi.fn>;
    };
    scholarDocument: {
      findFirst: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
      delete: ReturnType<typeof vi.fn>;
      deleteMany: ReturnType<typeof vi.fn>;
    };
  };
  let audit: { log: ReturnType<typeof vi.fn> };
  let events: { emitToStaff: ReturnType<typeof vi.fn> };
  let cloudinary: { uploadDocument: ReturnType<typeof vi.fn> };
  let ocr: {
    parseCor: ReturnType<typeof vi.fn>;
    parseSoa: ReturnType<typeof vi.fn>;
    parseConsolidated: ReturnType<typeof vi.fn>;
  };
  let auditEngine: { runAudit: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    prisma = {
      scholarProfile: { findUnique: vi.fn() },
      gradeReport: { findFirst: vi.fn() },
      termEnrollment: {
        findFirst: vi.fn(),
        findMany: vi.fn(),
        upsert: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        deleteMany: vi.fn(),
      },
      scholarDocument: {
        findFirst: vi.fn(),
        findUnique: vi.fn(),
        create: vi.fn(),
        delete: vi.fn(),
        deleteMany: vi.fn(),
      },
    };
    audit = { log: vi.fn() };
    events = { emitToStaff: vi.fn() };
    cloudinary = { uploadDocument: vi.fn() };
    ocr = {
      parseCor: vi.fn(),
      parseSoa: vi.fn(),
      parseConsolidated: vi.fn(),
    };
    auditEngine = { runAudit: vi.fn() };

    prisma.scholarProfile.findUnique.mockResolvedValue(scholar);
    prisma.gradeReport.findFirst.mockResolvedValue(null);
    prisma.termEnrollment.findFirst.mockResolvedValue(null);
    prisma.termEnrollment.findMany.mockResolvedValue([]);
    prisma.termEnrollment.update.mockResolvedValue({});
    prisma.termEnrollment.delete.mockResolvedValue({});
    prisma.termEnrollment.deleteMany.mockResolvedValue({ count: 0 });
    prisma.scholarDocument.findFirst.mockResolvedValue(null);
    prisma.scholarDocument.findUnique.mockResolvedValue(null);
    prisma.scholarDocument.create.mockResolvedValue({ document_id: 77 });
    prisma.scholarDocument.delete.mockResolvedValue({});
    prisma.scholarDocument.deleteMany.mockResolvedValue({ count: 0 });
    cloudinary.uploadDocument.mockResolvedValue({
      secure_url: 'https://cdn.test/cor.pdf',
    });
    auditEngine.runAudit.mockResolvedValue(auditResult);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ScholarEnrollmentService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: EventsGateway, useValue: events },
        { provide: CloudinaryService, useValue: cloudinary },
        { provide: EnrollmentOcrService, useValue: ocr },
        { provide: EnrollmentAuditEngineService, useValue: auditEngine },
      ],
    }).compile();

    service = module.get<ScholarEnrollmentService>(ScholarEnrollmentService);
  });

  it('is created by the Nest testing module', () => {
    expect(service).toBeDefined();
  });

  describe('getCurrentEnrollment', () => {
    it('throws NotFoundException when the logged-in user has no scholar profile', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue(null);

      await expect(service.getCurrentEnrollment(3)).rejects.toThrow(
        new NotFoundException('Scholar profile not found for current user.'),
      );
    });

    it('returns the active draft, previous completed enrollment, freeze state, and lock state', async () => {
      const current = { enrollment_id: 1, status: 'DRAFT' };
      const completed = { enrollment_id: 2, status: 'COMPLETED' };
      prisma.termEnrollment.findFirst
        .mockResolvedValueOnce(current)
        .mockResolvedValueOnce(completed);

      const result = await service.getCurrentEnrollment(3);

      expect(result).toEqual({
        scholar,
        enrollment: current,
        completed_previous_enrollment: completed,
        prospectus_frozen: true,
        academic_lock: { is_locked: false },
      });
      expect(prisma.termEnrollment.findFirst).toHaveBeenNthCalledWith(1, {
        where: {
          scholar_profile_id: 10,
          status: { not: 'COMPLETED' },
        },
        orderBy: { created_at: 'desc' },
        include: {
          cor_document: true,
          soa_document: true,
          disbursement: true,
        },
      });
      expect(prisma.termEnrollment.findFirst).toHaveBeenNthCalledWith(2, {
        where: {
          scholar_profile_id: 10,
          status: 'COMPLETED',
        },
        orderBy: { updated_at: 'desc' },
        include: { disbursement: true },
      });
      expect(prisma.gradeReport.findFirst).toHaveBeenCalledWith({
        where: {
          scholar_profile_id: 10,
          status: 'FLAGGED',
          appeal_status: { not: 'APPROVED' },
        },
        orderBy: { submitted_at: 'desc' },
      });
    });

    it('scopes the current enrollment lookup when an academic year and semester are supplied', async () => {
      await service.getCurrentEnrollment(3, '2026-2027', 'Summer');

      expect(prisma.termEnrollment.findFirst).toHaveBeenNthCalledWith(1, {
        where: {
          scholar_profile_id: 10,
          academic_year: '2026-2027',
          semester: 'Summer',
        },
        orderBy: { created_at: 'desc' },
        include: {
          cor_document: true,
          soa_document: true,
          disbursement: true,
        },
      });
    });

    it('auto-completes an approved term once the scholar has a confirmed CCG', async () => {
      const current = {
        enrollment_id: 1,
        status: 'SUBMITTED',
        academic_year: '2025-2026',
        semester: '2nd Semester',
        coordinator_notes: null,
      };
      prisma.termEnrollment.findFirst
        .mockResolvedValueOnce(current)
        .mockResolvedValueOnce(null);
      prisma.scholarDocument.findFirst.mockResolvedValue({ document_id: 9 });
      prisma.gradeReport.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);

      const result = await service.getCurrentEnrollment(3);

      expect(prisma.scholarDocument.findFirst).toHaveBeenCalledWith({
        where: {
          scholar_profile_id: 10,
          document_type: 'CCG',
          status: { in: ['STUDENT_CONFIRMED', 'VERIFIED'] },
        },
      });
      expect(prisma.termEnrollment.update).toHaveBeenCalledWith({
        where: { enrollment_id: 1 },
        data: {
          status: 'COMPLETED',
          coordinator_notes:
            'Term concluded with CCG submission. Cleared for next term enrollment.',
        },
      });
      expect(result.enrollment).toBeNull();
    });

    it('auto-completes an approved term when a grade report exists and preserves prior notes', async () => {
      const current = {
        enrollment_id: 1,
        status: 'APPROVED',
        academic_year: '2025-2026',
        semester: '2nd Semester',
        coordinator_notes: 'Reviewed by coordinator',
      };
      prisma.termEnrollment.findFirst
        .mockResolvedValueOnce(current)
        .mockResolvedValueOnce(null);
      prisma.scholarDocument.findFirst.mockResolvedValue(null);
      prisma.gradeReport.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ report_id: 31 });

      await service.getCurrentEnrollment(3);

      expect(prisma.gradeReport.findFirst).toHaveBeenNthCalledWith(2, {
        where: {
          scholar_profile_id: 10,
          OR: [
            { term_enrollment_id: 1 },
            { academic_year: '2025-2026', semester: '2nd Semester' },
          ],
        },
      });
      expect(prisma.termEnrollment.update).toHaveBeenCalledWith({
        where: { enrollment_id: 1 },
        data: {
          status: 'COMPLETED',
          coordinator_notes:
            'Reviewed by coordinator | Term concluded with CCG submission.',
        },
      });
    });

    it('keeps an approved term open until a CCG or grade report arrives', async () => {
      const current = { enrollment_id: 1, status: 'APPROVED' };
      prisma.termEnrollment.findFirst
        .mockResolvedValueOnce(current)
        .mockResolvedValueOnce(null);
      prisma.scholarDocument.findFirst.mockResolvedValue(null);
      prisma.gradeReport.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);

      const result = await service.getCurrentEnrollment(3);

      expect(prisma.termEnrollment.update).not.toHaveBeenCalled();
      expect(result.enrollment).toBe(current);
    });

    it('locks enrollment while a flag awaits the grantor verdict', async () => {
      prisma.gradeReport.findFirst.mockResolvedValue({
        report_id: 55,
        appeal_status: 'PENDING_GRANTOR',
        academic_year: '2025-2026',
        semester: '2nd Semester',
        gpa: '2.50',
        evaluation_flag: 'BELOW_PASSING_MARK',
      });

      const result = await service.getCurrentEnrollment(3);

      expect(result.academic_lock).toEqual({
        is_locked: true,
        reason: 'APPEAL_PENDING',
        appeal_status: 'PENDING_GRANTOR',
        report_id: 55,
        academic_year: '2025-2026',
        semester: '2nd Semester',
        gpa: 2.5,
        evaluation_flag: 'BELOW_PASSING_MARK',
        message:
          "Your academic appeal has been submitted and is awaiting the Grantor's verdict. Start-of-term enrollment is locked until your appeal verdict is decided.",
      });
    });

    it('discontinues enrollment after a denied appeal', async () => {
      prisma.gradeReport.findFirst.mockResolvedValue({
        report_id: 56,
        appeal_status: 'DENIED',
        academic_year: '2025-2026',
        semester: '2nd Semester',
        gpa: 2.75,
        evaluation_flag: 'ACADEMIC_FAILURE',
      });

      const result = await service.getCurrentEnrollment(3);

      expect(result.academic_lock).toMatchObject({
        is_locked: true,
        reason: 'DISCONTINUED',
        message:
          'Your scholarship agreement has been discontinued following an appeal denial.',
      });
    });

    it('requires a second-chance appeal for newly flagged standing', async () => {
      prisma.gradeReport.findFirst.mockResolvedValue({
        report_id: 57,
        appeal_status: 'PENDING_SCHOLAR',
        academic_year: '2025-2026',
        semester: '2nd Semester',
        gpa: 2.75,
        evaluation_flag: 'BELOW_PASSING_MARK',
      });

      const result = await service.getCurrentEnrollment(3);

      expect(result.academic_lock).toMatchObject({
        is_locked: true,
        reason: 'APPEAL_REQUIRED',
        message:
          'Your academic standing is under review due to a flagged grade report. Please submit a Second Chance Appeal before enrolling for the next term.',
      });
    });
  });

  describe('uploadAndParseCor', () => {
    it('blocks the upload while academic standing is locked', async () => {
      prisma.gradeReport.findFirst.mockResolvedValue({
        report_id: 1,
        appeal_status: 'PENDING_GRANTOR',
        academic_year: '2025-2026',
        semester: '2nd Semester',
        gpa: 2.5,
        evaluation_flag: 'BELOW_PASSING_MARK',
      });

      await expect(service.uploadAndParseCor(3, makeFile())).rejects.toThrow(
        BadRequestException,
      );
      expect(cloudinary.uploadDocument).not.toHaveBeenCalled();
      expect(ocr.parseCor).not.toHaveBeenCalled();
    });

    it('requires a COR file', async () => {
      await expect(
        service.uploadAndParseCor(
          3,
          undefined as unknown as Express.Multer.File,
        ),
      ).rejects.toThrow(new BadRequestException('No COR file uploaded.'));
    });

    it('rejects wrong COR documents before uploading to Cloudinary', async () => {
      ocr.parseCor.mockRejectedValue(
        new BadRequestException('Wrong document uploaded.'),
      );

      await expect(service.uploadAndParseCor(3, makeFile())).rejects.toThrow(
        new BadRequestException('Wrong document uploaded.'),
      );
      expect(cloudinary.uploadDocument).not.toHaveBeenCalled();
    });

    it('uploads, parses, audits, stores the document, and upserts a draft', async () => {
      ocr.parseCor.mockResolvedValue(extractedCor);
      prisma.termEnrollment.upsert.mockResolvedValue({
        enrollment_id: 1,
        status: 'DRAFT',
      });
      const file = makeFile();

      const result = await service.uploadAndParseCor(3, file);

      expect(cloudinary.uploadDocument).toHaveBeenCalledWith(
        file,
        'viascholar/enrollment/cor',
      );
      expect(ocr.parseCor).toHaveBeenCalledWith({
        buffer: file.buffer,
        fileName: 'cor.pdf',
        mimeType: 'application/pdf',
      });
      expect(prisma.scholarDocument.create).toHaveBeenCalledWith({
        data: {
          scholar_profile_id: 10,
          document_type: 'CERTIFICATE_OF_REGISTRATION',
          label: 'COR - 2026-2027 1st Semester',
          file_name: 'cor.pdf',
          file_url: 'https://cdn.test/cor.pdf',
          file_size: '1.0 KB',
          file_type: 'pdf',
          status: 'PASSED_PRECHECK',
          extracted_data: extractedCor,
        },
      });
      expect(auditEngine.runAudit).toHaveBeenCalledWith(
        10,
        extractedCor.subjects,
        {
          corStudentId: '2020-001',
          corStudentName: 'Ana Cruz',
          academicYear: '2026-2027',
          semester: '1st Semester',
        },
      );
      expect(prisma.termEnrollment.upsert).toHaveBeenCalledWith({
        where: {
          scholar_profile_id_academic_year_semester: {
            scholar_profile_id: 10,
            academic_year: '2026-2027',
            semester: '1st Semester',
          },
        },
        create: {
          scholar_profile_id: 10,
          academic_year: '2026-2027',
          semester: '1st Semester',
          year_level: 2,
          is_consolidated: false,
          cor_document_id: 77,
          total_units: 15,
          total_assessment: 0,
          status: 'DRAFT',
          audit_flags: auditResult.flags,
          enrolled_subjects: extractedCor.subjects,
          cross_doc_reconciliation: auditResult.cross_doc_reconciliation,
        },
        update: {
          cor_document_id: 77,
          enrolled_subjects: extractedCor.subjects,
          total_units: 15,
          year_level: 2,
          audit_flags: auditResult.flags,
          cross_doc_reconciliation: auditResult.cross_doc_reconciliation,
        },
        include: {
          cor_document: true,
          soa_document: true,
        },
      });
      expect(result).toEqual({
        document_id: 77,
        file_url: 'https://cdn.test/cor.pdf',
        extracted_data: extractedCor,
        draft_enrollment: { enrollment_id: 1, status: 'DRAFT' },
        audit_result: auditResult,
      });
    });

    it('defaults the term and year level when OCR cannot detect them', async () => {
      ocr.parseCor.mockResolvedValue({
        total_units: 0,
        subjects: extractedCor.subjects,
      });

      await service.uploadAndParseCor(3, makeFile());

      const upsertArgs = prisma.termEnrollment.upsert.mock.calls[0][0] as {
        create: Record<string, unknown>;
      };

      expect(upsertArgs.create).toEqual(
        objectMatching({
          academic_year: '2026-2027',
          semester: '1st Semester',
          year_level: 2,
          total_units: 0,
        }),
      );
      expect(prisma.scholarDocument.create).toHaveBeenCalledWith(
        objectMatching({
          data: objectMatching({
            label: 'COR - Current ',
          }),
        }),
      );
    });

    it('deletes an unverified COR document from an existing draft before replacing it', async () => {
      ocr.parseCor.mockResolvedValue(extractedCor);
      prisma.termEnrollment.findFirst.mockResolvedValue({
        cor_document_id: 66,
      });
      prisma.scholarDocument.findUnique.mockResolvedValue({
        document_id: 66,
        status: 'PASSED_PRECHECK',
      });

      await service.uploadAndParseCor(3, makeFile());

      expect(prisma.scholarDocument.delete).toHaveBeenCalledWith({
        where: { document_id: 66 },
      });
    });

    it('keeps a verified COR document when re-uploading a draft', async () => {
      ocr.parseCor.mockResolvedValue(extractedCor);
      prisma.termEnrollment.findFirst.mockResolvedValue({
        cor_document_id: 66,
      });
      prisma.scholarDocument.findUnique.mockResolvedValue({
        document_id: 66,
        status: 'VERIFIED',
      });

      await service.uploadAndParseCor(3, makeFile());

      expect(prisma.scholarDocument.delete).not.toHaveBeenCalled();
    });

    it('marks non-PDF uploads as images', async () => {
      ocr.parseCor.mockResolvedValue(extractedCor);

      await service.uploadAndParseCor(
        3,
        makeFile(2048, 'scan.png', 'image/png'),
      );

      expect(prisma.scholarDocument.create).toHaveBeenCalledWith(
        objectMatching({
          data: objectMatching({
            file_type: 'image',
            file_size: '2.0 KB',
          }),
        }),
      );
    });

    it('merges an existing SOA draft with a mismatched academic year when uploading COR', async () => {
      ocr.parseCor.mockResolvedValue({
        ...extractedCor,
        academic_year: '2024',
        semester: 'Summer',
      });
      prisma.termEnrollment.findFirst.mockResolvedValue(null);
      prisma.termEnrollment.findMany.mockResolvedValue([
        {
          enrollment_id: 99,
          scholar_profile_id: 10,
          academic_year: '2026-2027',
          semester: 'Summer',
          status: 'DRAFT',
          cor_document_id: null,
          soa_document_id: 88,
          total_assessment: 12698.5,
          assessment_date: new Date('2024-06-05T00:00:00.000Z'),
          billing_breakdown: { tuition_fee: 10000, net_balance_due: 12698.5 },
        },
      ]);

      await service.uploadAndParseCor(3, makeFile());

      expect(prisma.termEnrollment.delete).toHaveBeenCalledWith({
        where: { enrollment_id: 99 },
      });
      expect(prisma.termEnrollment.upsert).toHaveBeenCalledWith(
        objectMatching({
          where: {
            scholar_profile_id_academic_year_semester: {
              scholar_profile_id: 10,
              academic_year: '2024',
              semester: 'Summer',
            },
          },
          create: objectMatching({
            cor_document_id: 77,
            soa_document_id: 88,
            total_assessment: 12698.5,
          }),
          update: objectMatching({
            cor_document_id: 77,
            soa_document_id: 88,
            total_assessment: 12698.5,
          }),
        }),
      );
    });
  });

  describe('uploadAndParseSoa', () => {
    it('blocks the upload while academic standing is locked', async () => {
      prisma.gradeReport.findFirst.mockResolvedValue({
        report_id: 1,
        appeal_status: 'DENIED',
        academic_year: '2025-2026',
        semester: '2nd Semester',
        gpa: 3,
        evaluation_flag: 'ACADEMIC_FAILURE',
      });

      await expect(service.uploadAndParseSoa(3, makeFile())).rejects.toThrow(
        BadRequestException,
      );
      expect(cloudinary.uploadDocument).not.toHaveBeenCalled();
    });

    it('requires a SOA file', async () => {
      await expect(
        service.uploadAndParseSoa(
          3,
          undefined as unknown as Express.Multer.File,
        ),
      ).rejects.toThrow(new BadRequestException('No SOA file uploaded.'));
    });

    it('uploads billing data, audits existing subjects, and stores a draft with the fee breakdown', async () => {
      ocr.parseSoa.mockResolvedValue(extractedSoa);
      prisma.termEnrollment.findFirst
        .mockResolvedValueOnce({ soa_document_id: 88, cor_document_id: 77 })
        .mockResolvedValueOnce({
          enrolled_subjects: extractedCor.subjects,
        });
      prisma.scholarDocument.findUnique.mockResolvedValue({
        document_id: 88,
        status: 'PASSED_PRECHECK',
      });
      prisma.termEnrollment.upsert.mockResolvedValue({
        enrollment_id: 2,
        status: 'DRAFT',
      });
      const file = makeFile(2048, 'soa.pdf', 'application/pdf');

      const result = await service.uploadAndParseSoa(3, file);

      expect(cloudinary.uploadDocument).toHaveBeenCalledWith(
        file,
        'viascholar/enrollment/soa',
      );
      expect(prisma.scholarDocument.delete).toHaveBeenCalledWith({
        where: { document_id: 88 },
      });
      expect(prisma.scholarDocument.create).toHaveBeenCalledWith({
        data: {
          scholar_profile_id: 10,
          document_type: 'STATEMENT_OF_ACCOUNT',
          label: 'SOA - 2026-2027 2nd Semester',
          file_name: 'soa.pdf',
          file_url: 'https://cdn.test/cor.pdf',
          file_size: '2.0 KB',
          file_type: 'pdf',
          status: 'PASSED_PRECHECK',
          extracted_data: extractedSoa,
        },
      });
      expect(auditEngine.runAudit).toHaveBeenCalledWith(
        10,
        extractedCor.subjects,
        {
          soaStudentId: '2020-001',
          soaStudentName: 'Ana Cruz',
          academicYear: '2026-2027',
          semester: '2nd Semester',
        },
      );
      expect(prisma.termEnrollment.upsert).toHaveBeenCalledWith(
        objectMatching({
          create: objectMatching({
            soa_document_id: 77,
            total_units: 0,
            total_assessment: 12000,
            assessment_date: new Date('2026-06-01T00:00:00.000Z'),
            status: 'DRAFT',
            billing_breakdown: {
              tuition_fee: '9000',
              lab_fees: 1500,
              misc_fees: null,
              other_fees: undefined,
              previous_balance: 0,
              discounts: 500,
              net_balance_due: 11000,
            },
          }),
        }),
      );
      expect(result.document_id).toBe(77);
      expect(result.draft_enrollment).toEqual({
        enrollment_id: 2,
        status: 'DRAFT',
      });
    });

    it('keeps a verified SOA document when re-uploading a draft', async () => {
      ocr.parseSoa.mockResolvedValue(extractedSoa);
      prisma.termEnrollment.findFirst
        .mockResolvedValueOnce({ soa_document_id: 88, cor_document_id: 77 })
        .mockResolvedValueOnce(null);
      prisma.scholarDocument.findUnique.mockResolvedValue({
        document_id: 88,
        status: 'VERIFIED',
      });

      await service.uploadAndParseSoa(3, makeFile());

      expect(prisma.scholarDocument.delete).not.toHaveBeenCalled();
    });

    it('does not delete a consolidated COR/SOA document during SOA re-upload', async () => {
      ocr.parseSoa.mockResolvedValue(extractedSoa);
      prisma.termEnrollment.findFirst
        .mockResolvedValueOnce({ soa_document_id: 77, cor_document_id: 77 })
        .mockResolvedValueOnce(null);

      await service.uploadAndParseSoa(3, makeFile());

      expect(prisma.scholarDocument.findUnique).not.toHaveBeenCalled();
      expect(prisma.scholarDocument.delete).not.toHaveBeenCalled();
    });

    it('stores a null assessment date when OCR does not provide a valid date', async () => {
      ocr.parseSoa.mockResolvedValue({
        ...extractedSoa,
        assessment_date: 'N/A',
      });

      await service.uploadAndParseSoa(3, makeFile());

      const upsertArgs = prisma.termEnrollment.upsert.mock.calls[0][0] as {
        create: Record<string, unknown>;
      };

      expect(upsertArgs.create.assessment_date).toBeNull();
    });

    it('rejects wrong SOA documents before uploading to Cloudinary', async () => {
      ocr.parseSoa.mockRejectedValue(
        new BadRequestException('Wrong SOA document uploaded.'),
      );

      await expect(service.uploadAndParseSoa(3, makeFile())).rejects.toThrow(
        new BadRequestException('Wrong SOA document uploaded.'),
      );
      expect(cloudinary.uploadDocument).not.toHaveBeenCalled();
    });
  });

  describe('uploadAndParseConsolidated', () => {
    it('blocks the upload while academic standing is locked', async () => {
      prisma.gradeReport.findFirst.mockResolvedValue({
        report_id: 1,
        appeal_status: 'PENDING_GRANTOR',
        academic_year: '2025-2026',
        semester: '2nd Semester',
        gpa: 2.5,
        evaluation_flag: 'BELOW_PASSING_MARK',
      });

      await expect(
        service.uploadAndParseConsolidated(3, makeFile()),
      ).rejects.toThrow(BadRequestException);
    });

    it('requires a consolidated file', async () => {
      await expect(
        service.uploadAndParseConsolidated(
          3,
          undefined as unknown as Express.Multer.File,
        ),
      ).rejects.toThrow(
        new BadRequestException('No consolidated file uploaded.'),
      );
    });

    it('stores a single consolidated document linked as both COR and SOA', async () => {
      ocr.parseConsolidated.mockResolvedValue(extractedConsolidated);
      prisma.termEnrollment.upsert.mockResolvedValue({
        enrollment_id: 3,
        status: 'DRAFT',
      });

      const result = await service.uploadAndParseConsolidated(3, makeFile());

      expect(ocr.parseConsolidated).toHaveBeenCalled();
      expect(prisma.scholarDocument.create).toHaveBeenCalledWith({
        data: objectMatching({
          document_type: 'CONSOLIDATED_MATRICULATION',
          label: 'Consolidated COR/SOA - 2026-2027 1st Semester',
          file_type: 'pdf',
          status: 'PASSED_PRECHECK',
        }),
      });
      expect(auditEngine.runAudit).toHaveBeenCalledWith(
        10,
        extractedConsolidated.subjects,
        {
          corStudentId: '2020-001',
          corStudentName: 'Ana Cruz',
          soaStudentId: '2020-001',
          soaStudentName: 'Ana Cruz',
          academicYear: '2026-2027',
          semester: '1st Semester',
        },
      );
      expect(prisma.termEnrollment.upsert).toHaveBeenCalledWith(
        objectMatching({
          create: objectMatching({
            is_consolidated: true,
            cor_document_id: 77,
            soa_document_id: 77,
            total_units: 7,
            total_assessment: 15000,
            enrolled_subjects: extractedConsolidated.subjects,
            billing_breakdown: {
              tuition_fee: 10000,
              lab_fees: 2500,
              misc_fees: 500,
              other_fees: 1000,
              previous_balance: 250,
              discounts: 750,
              net_balance_due: 13500,
            },
          }),
        }),
      );
      expect(result.document_id).toBe(77);
    });

    it('deletes the previous unverified COR document before replacing a draft', async () => {
      ocr.parseConsolidated.mockResolvedValue(extractedConsolidated);
      prisma.termEnrollment.findFirst.mockResolvedValue({
        cor_document_id: 60,
      });
      prisma.scholarDocument.findUnique.mockResolvedValue({
        document_id: 60,
        status: 'PASSED_PRECHECK',
      });

      await service.uploadAndParseConsolidated(3, makeFile());

      expect(prisma.scholarDocument.delete).toHaveBeenCalledWith({
        where: { document_id: 60 },
      });
    });
  });

  describe('saveDraft', () => {
    it('blocks draft saves while academic standing is locked', async () => {
      prisma.gradeReport.findFirst.mockResolvedValue({
        report_id: 1,
        appeal_status: 'PENDING_GRANTOR',
        academic_year: '2025-2026',
        semester: '2nd Semester',
        gpa: 2.5,
        evaluation_flag: 'BELOW_PASSING_MARK',
      });

      await expect(service.saveDraft(3, makeSubmitDto())).rejects.toThrow(
        BadRequestException,
      );
      expect(auditEngine.runAudit).not.toHaveBeenCalled();
    });

    it('audits and upserts a draft with the submitted subjects and billing', async () => {
      prisma.termEnrollment.upsert.mockResolvedValue({ enrollment_id: 4 });
      const dto = makeSubmitDto();

      const result = await service.saveDraft(3, dto);

      expect(auditEngine.runAudit).toHaveBeenCalledWith(
        10,
        dto.enrolled_subjects,
        { academicYear: '2026-2027', semester: '1st Semester' },
      );
      expect(prisma.termEnrollment.upsert).toHaveBeenCalledWith(
        objectMatching({
          create: objectMatching({
            year_level: 2,
            is_consolidated: false,
            cor_document_id: 77,
            soa_document_id: 88,
            total_units: 15,
            total_assessment: 12000,
            assessment_date: new Date('2026-06-01T00:00:00.000Z'),
            status: 'DRAFT',
            audit_flags: auditResult.flags,
            enrolled_subjects: dto.enrolled_subjects,
            billing_breakdown: dto.billing_breakdown,
            cross_doc_reconciliation: auditResult.cross_doc_reconciliation,
          }),
        }),
      );
      expect(result).toEqual({
        message: 'Draft enrollment saved successfully.',
        enrollment: { enrollment_id: 4 },
        audit_result: auditResult,
      });
    });

    it('honors consolidated mode and a missing assessment date', async () => {
      await service.saveDraft(
        3,
        makeSubmitDto({
          is_consolidated: true,
          assessment_date: undefined,
        }),
      );

      const upsertArgs = prisma.termEnrollment.upsert.mock.calls[0][0] as {
        create: Record<string, unknown>;
      };

      expect(upsertArgs.create.is_consolidated).toBe(true);
      expect(upsertArgs.create.assessment_date).toBeNull();
    });
  });

  describe('discardDraft', () => {
    it('deletes all drafts and their unverified supporting documents', async () => {
      prisma.termEnrollment.findMany.mockResolvedValue([
        { cor_document_id: 1, soa_document_id: 2 },
        { cor_document_id: 3, soa_document_id: 3 },
        { cor_document_id: null, soa_document_id: null },
      ]);
      prisma.termEnrollment.deleteMany.mockResolvedValue({ count: 3 });

      const result = await service.discardDraft(3);

      expect(prisma.termEnrollment.findMany).toHaveBeenCalledWith({
        where: { scholar_profile_id: 10, status: 'DRAFT' },
        select: { cor_document_id: true, soa_document_id: true },
      });
      expect(prisma.termEnrollment.deleteMany).toHaveBeenCalledWith({
        where: { scholar_profile_id: 10, status: 'DRAFT' },
      });
      expect(prisma.scholarDocument.deleteMany).toHaveBeenCalledWith({
        where: {
          document_id: { in: [1, 2, 3] },
          status: { not: 'VERIFIED' },
        },
      });
      expect(result).toEqual({
        message: 'Draft enrollment cleared successfully.',
        count: 3,
      });
    });

    it('scopes the discard to an explicit academic year and semester', async () => {
      prisma.termEnrollment.deleteMany.mockResolvedValue({ count: 1 });

      await service.discardDraft(3, '2026-2027', 'Summer');

      expect(prisma.termEnrollment.findMany).toHaveBeenCalledWith({
        where: {
          scholar_profile_id: 10,
          status: 'DRAFT',
          academic_year: '2026-2027',
          semester: 'Summer',
        },
        select: { cor_document_id: true, soa_document_id: true },
      });
    });

    it('skips document cleanup when the draft has no documents', async () => {
      prisma.termEnrollment.findMany.mockResolvedValue([
        { cor_document_id: null, soa_document_id: null },
      ]);

      await service.discardDraft(3);

      expect(prisma.scholarDocument.deleteMany).not.toHaveBeenCalled();
    });

    it('still clears the draft when document cleanup rejects', async () => {
      prisma.termEnrollment.findMany.mockResolvedValue([
        { cor_document_id: 1, soa_document_id: null },
      ]);
      prisma.scholarDocument.deleteMany.mockRejectedValue(
        new Error('document locked'),
      );

      await expect(service.discardDraft(3)).resolves.toEqual({
        message: 'Draft enrollment cleared successfully.',
        count: 0,
      });
    });
  });

  describe('clearDraftDocument', () => {
    it('returns success when there is no active draft', async () => {
      prisma.termEnrollment.findFirst.mockResolvedValue(null);

      await expect(service.clearDraftDocument(3, 'cor')).resolves.toEqual({
        success: true,
        message: 'No active draft found to clear.',
      });
    });

    it('removes only the COR while keeping a separate SOA draft', async () => {
      prisma.termEnrollment.findFirst.mockResolvedValue({
        enrollment_id: 1,
        cor_document_id: 5,
        soa_document_id: 6,
      });

      const result = await service.clearDraftDocument(3, 'cor');

      expect(prisma.scholarDocument.delete).toHaveBeenCalledWith({
        where: { document_id: 5 },
      });
      expect(prisma.termEnrollment.update).toHaveBeenCalledWith({
        where: { enrollment_id: 1 },
        data: {
          cor_document_id: null,
          enrolled_subjects: [],
          total_units: 0,
          audit_flags: [],
        },
      });
      expect(result).toEqual({
        success: true,
        message: 'Proof of subjects removed from draft.',
      });
    });

    it('resets the draft entirely when removing the COR leaves no SOA', async () => {
      prisma.termEnrollment.findFirst.mockResolvedValue({
        enrollment_id: 1,
        cor_document_id: 5,
        soa_document_id: null,
      });

      const result = await service.clearDraftDocument(3, 'cor');

      expect(prisma.termEnrollment.delete).toHaveBeenCalledWith({
        where: { enrollment_id: 1 },
      });
      expect(result.message).toBe('Enrollment draft reset.');
    });

    it('resets the draft when COR and SOA point at the same consolidated document', async () => {
      prisma.termEnrollment.findFirst.mockResolvedValue({
        enrollment_id: 1,
        cor_document_id: 5,
        soa_document_id: 5,
      });

      await service.clearDraftDocument(3, 'cor');

      expect(prisma.termEnrollment.delete).toHaveBeenCalledWith({
        where: { enrollment_id: 1 },
      });
    });

    it('removes only the SOA while keeping a separate COR draft', async () => {
      prisma.termEnrollment.findFirst.mockResolvedValue({
        enrollment_id: 1,
        cor_document_id: 5,
        soa_document_id: 6,
      });

      const result = await service.clearDraftDocument(3, 'soa');

      expect(prisma.scholarDocument.delete).toHaveBeenCalledWith({
        where: { document_id: 6 },
      });
      expect(prisma.termEnrollment.update).toHaveBeenCalledWith({
        where: { enrollment_id: 1 },
        data: {
          soa_document_id: null,
          total_assessment: 0,
          assessment_date: null,
          billing_breakdown: {},
        },
      });
      expect(result.message).toBe('Proof of billing removed from draft.');
    });

    it('resets the draft entirely when removing the SOA leaves no COR', async () => {
      prisma.termEnrollment.findFirst.mockResolvedValue({
        enrollment_id: 1,
        cor_document_id: null,
        soa_document_id: 6,
      });

      await service.clearDraftDocument(3, 'soa');

      expect(prisma.termEnrollment.delete).toHaveBeenCalledWith({
        where: { enrollment_id: 1 },
      });
    });

    it('removes every consolidated document and resets the draft', async () => {
      prisma.termEnrollment.findFirst.mockResolvedValue({
        enrollment_id: 1,
        cor_document_id: 5,
        soa_document_id: 6,
      });

      const result = await service.clearDraftDocument(3, 'consolidated');

      expect(prisma.scholarDocument.deleteMany).toHaveBeenCalledWith({
        where: { document_id: { in: [5, 6] } },
      });
      expect(prisma.termEnrollment.delete).toHaveBeenCalledWith({
        where: { enrollment_id: 1 },
      });
      expect(result.message).toBe(
        'Consolidated document removed and draft reset.',
      );
    });

    it('still updates the draft when the document delete rejects', async () => {
      prisma.termEnrollment.findFirst.mockResolvedValue({
        enrollment_id: 1,
        cor_document_id: 5,
        soa_document_id: 6,
      });
      prisma.scholarDocument.delete.mockRejectedValue(new Error('locked'));

      await expect(service.clearDraftDocument(3, 'cor')).resolves.toEqual({
        success: true,
        message: 'Proof of subjects removed from draft.',
      });
      expect(prisma.termEnrollment.update).toHaveBeenCalled();
    });

    it('returns a generic success for an unknown document type', async () => {
      prisma.termEnrollment.findFirst.mockResolvedValue({
        enrollment_id: 1,
        cor_document_id: 5,
        soa_document_id: 6,
      });

      await expect(
        service.clearDraftDocument(3, 'unknown' as unknown as 'cor'),
      ).resolves.toEqual({ success: true, message: 'Document cleared.' });
    });
  });

  describe('runPreAudit', () => {
    it('runs the audit engine against the scholar prospectus and submitted term', async () => {
      const dto = makeSubmitDto();
      prisma.scholarProfile.findUnique.mockResolvedValue(scholar);

      const result = await service.runPreAudit(3, dto);

      expect(auditEngine.runAudit).toHaveBeenCalledWith(
        10,
        dto.enrolled_subjects,
        { academicYear: '2026-2027', semester: '1st Semester' },
      );
      expect(result).toBe(auditResult);
    });
  });

  describe('submitEnrollment', () => {
    it('blocks final submission while academic standing is locked', async () => {
      prisma.gradeReport.findFirst.mockResolvedValue({
        report_id: 1,
        appeal_status: 'DENIED',
        academic_year: '2025-2026',
        semester: '2nd Semester',
        gpa: 3,
        evaluation_flag: 'ACADEMIC_FAILURE',
      });

      await expect(
        service.submitEnrollment(3, makeSubmitDto()),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.termEnrollment.upsert).not.toHaveBeenCalled();
    });

    it('submits for review, audits the action, and notifies staff', async () => {
      const dto = makeSubmitDto();
      prisma.termEnrollment.upsert.mockResolvedValue({ enrollment_id: 8 });

      const result = await service.submitEnrollment(3, dto);

      expect(prisma.termEnrollment.upsert).toHaveBeenCalledWith(
        objectMatching({
          create: objectMatching({
            status: 'PENDING_REVIEW',
            enrolled_subjects: dto.enrolled_subjects,
          }),
          update: objectMatching({
            status: 'PENDING_REVIEW',
            enrolled_subjects: dto.enrolled_subjects,
          }),
        }),
      );
      expect(audit.log).toHaveBeenCalledWith(
        3,
        'SUBMIT_TERM_ENROLLMENT',
        'Submitted term enrollment for 2026-2027 1st Semester with total assessment PHP 12000',
      );
      expect(events.emitToStaff).toHaveBeenCalledWith(
        'enrollment:submitted_for_review',
        {
          enrollment_id: 8,
          scholar_id: 10,
          scholar_name: 'Ana Cruz',
          academic_year: '2026-2027',
          semester: '1st Semester',
          total_assessment: 12000,
          audit_flags: auditResult.flags,
        },
      );
      expect(result).toEqual({
        message:
          'Term enrollment submitted successfully for coordinator review.',
        enrollment: { enrollment_id: 8 },
        audit_result: auditResult,
      });
    });
  });
});
