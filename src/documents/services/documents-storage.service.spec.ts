import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DocumentsStorageService } from './documents-storage.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CloudinaryService } from '../../cloudinary/cloudinary.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { PdfMergerService } from './pdf-merger.service.js';
import { FileForensicsService } from './file-forensics.service.js';
import { DocumentOcrService } from './document-ocr.service.js';

const objectMatching = (shape: Record<string, unknown>) =>
  expect.objectContaining(shape) as Record<string, unknown>;
const stringMatching = (re: RegExp) => expect.stringMatching(re) as string;
const anyArg = (ctor: unknown) => expect.any(ctor) as unknown;

const createPrismaMock = () => ({
  scholarProfile: {
    findUnique: vi.fn(),
  },
  scholarDocument: {
    create: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  gradeReport: {
    findFirst: vi.fn(),
    deleteMany: vi.fn(),
  },
  termEnrollment: {
    findFirst: vi.fn(),
  },
});

const createAuditMock = () => ({ log: vi.fn() });
const createCloudinaryMock = () => ({ uploadBuffer: vi.fn() });
const createPdfMergerMock = () => ({ processAndMergeFiles: vi.fn() });
const createForensicsMock = () => ({ inspectFileMetadata: vi.fn() });
const createOcrMock = () => ({
  processDocumentExtraction: vi.fn().mockResolvedValue(undefined),
});

const makeScholar = (overrides: Record<string, unknown> = {}) => ({
  profile_id: 11,
  user_id: 7,
  current_year_level: 1,
  school_name: 'University of Mindanao',
  ...overrides,
});

const makeFile = (
  sizeBytes: number,
  name = 'report_card.png',
  mimetype = 'image/png',
): Express.Multer.File =>
  ({
    originalname: name,
    mimetype,
    size: sizeBytes,
    buffer: Buffer.from('img'),
  }) as Express.Multer.File;

const makeProcessed = (overrides: Record<string, unknown> = {}) => ({
  buffer: Buffer.from('processed'),
  fileName: 'report_card_front.pdf',
  fileSize: '0.1 KB',
  mimeType: 'application/pdf',
  isPdf: true,
  ...overrides,
});

describe('DocumentsStorageService', () => {
  let service: DocumentsStorageService;
  let prisma: ReturnType<typeof createPrismaMock>;
  let audit: ReturnType<typeof createAuditMock>;
  let cloudinary: ReturnType<typeof createCloudinaryMock>;
  let pdfMerger: ReturnType<typeof createPdfMergerMock>;
  let forensics: ReturnType<typeof createForensicsMock>;
  let ocr: ReturnType<typeof createOcrMock>;

  beforeEach(async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    prisma = createPrismaMock();
    audit = createAuditMock();
    cloudinary = createCloudinaryMock();
    pdfMerger = createPdfMergerMock();
    forensics = createForensicsMock();
    ocr = createOcrMock();

    prisma.scholarProfile.findUnique.mockResolvedValue(makeScholar());
    prisma.scholarDocument.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ document_id: 900, ...data }),
    );
    prisma.scholarDocument.findUnique.mockResolvedValue({
      document_id: 55,
      scholar_profile_id: 11,
      document_type: 'Form 138',
      status: 'PENDING',
      scholar_profile: makeScholar(),
    });
    prisma.scholarDocument.update.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ document_id: 55, ...data }),
    );
    prisma.scholarDocument.delete.mockResolvedValue({ document_id: 55 });
    prisma.gradeReport.findFirst.mockResolvedValue(null);
    prisma.gradeReport.deleteMany.mockResolvedValue({ count: 0 });

    forensics.inspectFileMetadata.mockResolvedValue({
      is_flagged: false,
      detected_software: [],
      flags: [],
    });
    pdfMerger.processAndMergeFiles.mockResolvedValue(makeProcessed());
    cloudinary.uploadBuffer.mockResolvedValue({
      secure_url: 'https://cdn.test/doc.pdf',
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DocumentsStorageService,
        { provide: PrismaService, useValue: prisma },
        { provide: CloudinaryService, useValue: cloudinary },
        { provide: AuditService, useValue: audit },
        { provide: PdfMergerService, useValue: pdfMerger },
        { provide: FileForensicsService, useValue: forensics },
        { provide: DocumentOcrService, useValue: ocr },
      ],
    }).compile();

    service = module.get<DocumentsStorageService>(DocumentsStorageService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is created by the Nest testing module', () => {
    expect(service).toBeDefined();
  });

  describe('uploadDocument', () => {
    it('throws NotFoundException when the scholar profile is missing', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue(null);

      await expect(
        service.uploadDocument(7, [makeFile(1024)], 'TOR'),
      ).rejects.toThrow(new NotFoundException('Scholar profile not found.'));
    });

    it('defaults the document type to Form 138 for a 1st-year student', async () => {
      await service.uploadDocument(7, [makeFile(1024)], '');

      expect(pdfMerger.processAndMergeFiles).toHaveBeenCalledWith(
        expect.any(Array),
        'Form 138',
      );
    });

    it('defaults the document type to TOR for 2nd-4th year students', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue(
        makeScholar({ current_year_level: 2 }),
      );

      await service.uploadDocument(
        7,
        [makeFile(1024, 'tor.pdf', 'application/pdf')],
        '',
      );

      expect(pdfMerger.processAndMergeFiles).toHaveBeenCalledWith(
        expect.any(Array),
        'TOR',
      );
    });

    it('rejects high school documents for 2nd to 4th year students', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue(
        makeScholar({ current_year_level: 3 }),
      );

      await expect(
        service.uploadDocument(7, [makeFile(1024)], 'Form 138'),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.uploadDocument(7, [makeFile(1024)], 'Form 137'),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects TAQ / TOR uploads for a 1st-year student', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue(
        makeScholar({ current_year_level: 1 }),
      );

      await expect(
        service.uploadDocument(7, [makeFile(1024)], 'TOR'),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects college transcripts for 1st-year students when not a college doc', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue(
        makeScholar({ current_year_level: 1 }),
      );

      await expect(
        service.uploadDocument(7, [makeFile(1024)], 'Random Document'),
      ).rejects.toThrow(BadRequestException);
    });

    it('allows form 138 for a 1st-year student and uploads it', async () => {
      const doc = await service.uploadDocument(7, [makeFile(1024)], 'Form 138');

      expect(cloudinary.uploadBuffer).toHaveBeenCalledWith(
        anyArg(Buffer),
        'viascholar/documents',
        stringMatching(/^report_card_front$/),
        'auto',
      );
      expect(prisma.scholarDocument.create).toHaveBeenCalledWith({
        data: objectMatching({
          document_type: 'Form 138',
          label: 'Senior High School Report Card (Form 138 / Form 9)',
          file_url: 'https://cdn.test/doc.pdf',
          status: 'PENDING',
          file_type: 'pdf',
        }),
      });
      expect(doc.document_id).toBeDefined();
      expect(audit.log).toHaveBeenCalledWith(
        7,
        'DOCUMENT_UPLOADED',
        stringMatching(/Type: Form 138/),
      );
      expect(ocr.processDocumentExtraction).toHaveBeenCalledWith(
        900,
        anyArg(Buffer),
        'report_card_front.pdf',
        'application/pdf',
        'Form 138',
        [expect.any(Object)],
      );
    });

    it('uses the TOR label for a 2nd to 4th year student TOR upload', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue(
        makeScholar({ current_year_level: 2 }),
      );

      await service.uploadDocument(
        7,
        [makeFile(1024, 'tor.pdf', 'application/pdf')],
        'TOR',
      );

      expect(prisma.scholarDocument.create).toHaveBeenCalledWith({
        data: objectMatching({
          label: 'College Transcript of Records (TOR)',
        }),
      });
    });

    it('flags unresolved flagged grade reports when uploading a college grade document', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue(
        makeScholar({ current_year_level: 2 }),
      );
      prisma.gradeReport.findFirst.mockResolvedValue({
        report_id: 42,
        appeal_status: 'PENDING_GRANTOR',
      });

      await expect(
        service.uploadDocument(
          7,
          [makeFile(1024, 'tor.pdf', 'application/pdf')],
          'TOR',
        ),
      ).rejects.toThrow(
        new BadRequestException(
          "Grade submission is paused while your academic appeal is awaiting the Grantor's verdict.",
        ),
      );
    });

    it('explains the denial discontinued message for a DENIED flagged report', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue(
        makeScholar({ current_year_level: 2 }),
      );
      prisma.gradeReport.findFirst.mockResolvedValue({
        report_id: 42,
        appeal_status: 'DENIED',
      });

      await expect(
        service.uploadDocument(
          7,
          [makeFile(1024, 'tor.pdf', 'application/pdf')],
          'TOR',
        ),
      ).rejects.toThrow(
        new BadRequestException(
          'Grade submission is unavailable because your scholarship was discontinued.',
        ),
      );
    });

    it('falls back to the generic appeal message for other appeal statuses', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue(
        makeScholar({ current_year_level: 2 }),
      );
      prisma.gradeReport.findFirst.mockResolvedValue({
        report_id: 42,
        appeal_status: 'NONE',
      });

      await expect(
        service.uploadDocument(
          7,
          [makeFile(1024, 'tor.pdf', 'application/pdf')],
          'TOR',
        ),
      ).rejects.toThrow(
        new BadRequestException(
          'Grade submission is paused. Please submit and resolve your Second Chance Appeal for your flagged grade report first.',
        ),
      );
    });

    it('blocks CCG uploads when the scholar has no active non-completed enrollment', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue(
        makeScholar({ current_year_level: 3 }),
      );
      prisma.termEnrollment.findFirst.mockResolvedValue(null);

      await expect(
        service.uploadDocument(
          7,
          [makeFile(1024, 'ccg.pdf', 'application/pdf')],
          'CCG',
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('reports the pending review error when the enrollment is pending', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue(
        makeScholar({ current_year_level: 3 }),
      );
      prisma.termEnrollment.findFirst.mockResolvedValue({
        enrollment_id: 50,
        status: 'PENDING_REVIEW',
        academic_year: '2026-2027',
        semester: '1st Semester',
      });

      await expect(
        service.uploadDocument(
          7,
          [makeFile(1024, 'ccg.pdf', 'application/pdf')],
          'CCG',
        ),
      ).rejects.toThrow(
        new BadRequestException(
          'Grade submission is locked. Your start-of-term enrollment for 2026-2027 (1st Semester) is currently pending coordinator review. Grades can only be uploaded once your enrollment is approved.',
        ),
      );
    });

    it('reports the changes-requested error when the coordinator requested changes', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue(
        makeScholar({ current_year_level: 3 }),
      );
      prisma.termEnrollment.findFirst.mockResolvedValue({
        enrollment_id: 50,
        status: 'CHANGES_REQUESTED',
        academic_year: '2026-2027',
        semester: '1st Semester',
      });

      await expect(
        service.uploadDocument(
          7,
          [makeFile(1024, 'ccg.pdf', 'application/pdf')],
          'CCG',
        ),
      ).rejects.toThrow(
        new BadRequestException(
          'Grade submission is locked. Your coordinator has requested changes to your start-of-term enrollment. Please update and resubmit your enrollment first.',
        ),
      );
    });

    it('reports the generic locked error for other non-approved enrollment statuses', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue(
        makeScholar({ current_year_level: 3 }),
      );
      prisma.termEnrollment.findFirst.mockResolvedValue({
        enrollment_id: 50,
        status: 'DRAFT',
        academic_year: '2026-2027',
        semester: '1st Semester',
      });

      await expect(
        service.uploadDocument(
          7,
          [makeFile(1024, 'ccg.pdf', 'application/pdf')],
          'CCG',
        ),
      ).rejects.toThrow(
        new BadRequestException(
          'Grade submission is locked. Your start-of-term enrollment has not been approved.',
        ),
      );
    });

    it('uploads a CCG when the enrollment is APPROVED', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue(
        makeScholar({ current_year_level: 3 }),
      );
      prisma.termEnrollment.findFirst.mockResolvedValue({
        enrollment_id: 50,
        status: 'APPROVED',
        academic_year: '2026-2027',
        semester: '1st Semester',
      });

      await service.uploadDocument(
        7,
        [makeFile(1024, 'ccg.pdf', 'application/pdf')],
        'CCG',
      );

      expect(pdfMerger.processAndMergeFiles).toHaveBeenCalledWith(
        expect.any(Array),
        'CCG',
      );
    });
  });

  describe('replaceDocument', () => {
    it('throws NotFoundException when the document is missing or not yours', async () => {
      prisma.scholarDocument.findUnique.mockResolvedValue(null);
      await expect(
        service.replaceDocument(7, 55, [makeFile(1024)]),
      ).rejects.toThrow(NotFoundException);

      prisma.scholarDocument.findUnique.mockResolvedValue({
        document_id: 55,
        document_type: 'Form 138',
        status: 'PENDING',
        scholar_profile: makeScholar({ user_id: 99 }),
      });
      await expect(
        service.replaceDocument(7, 55, [makeFile(1024)]),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException when the document is already confirmed or verified', async () => {
      prisma.scholarDocument.findUnique.mockResolvedValue({
        document_id: 55,
        document_type: 'Form 138',
        status: 'VERIFIED',
        scholar_profile: makeScholar(),
      });

      await expect(
        service.replaceDocument(7, 55, [makeFile(1024)]),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when no files are provided', async () => {
      await expect(service.replaceDocument(7, 55, [])).rejects.toThrow(
        new BadRequestException('No files provided for replacement.'),
      );
    });

    it('replaces the file, resets verification metadata, and re-triggers OCR', async () => {
      const updated = await service.replaceDocument(7, 55, [makeFile(1024)]);

      expect(prisma.scholarDocument.update).toHaveBeenCalledWith({
        where: { document_id: 55 },
        data: objectMatching({
          status: 'PENDING',
          rejection_reason: null,
          verified_at: null,
          reviewed_by_employee_id: null,
        }),
      });
      expect(audit.log).toHaveBeenCalledWith(
        7,
        'DOCUMENT_REPLACED',
        stringMatching(/Type: Form 138/),
      );
      expect(ocr.processDocumentExtraction).toHaveBeenCalledWith(
        55,
        anyArg(Buffer),
        'report_card_front.pdf',
        'application/pdf',
        'Form 138',
        [expect.any(Object)],
      );
      expect(updated.document_id).toBe(55);
    });
  });

  describe('deleteDocument', () => {
    it('throws NotFoundException when the document is missing or foreign', async () => {
      prisma.scholarDocument.findUnique.mockResolvedValue(null);
      await expect(service.deleteDocument(7, 55)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('refuses to delete a document linked to an approved grade report', async () => {
      prisma.gradeReport.findFirst.mockResolvedValue({ report_id: 42 });

      await expect(service.deleteDocument(7, 55)).rejects.toThrow(
        new BadRequestException(
          'This document is linked to an approved Grade Report and cannot be deleted.',
        ),
      );
      expect(prisma.scholarDocument.delete).not.toHaveBeenCalled();
    });

    it('deletes non-approved grade reports before removing the document', async () => {
      const result = await service.deleteDocument(7, 55);

      expect(prisma.gradeReport.deleteMany).toHaveBeenCalledWith({
        where: { document_id: 55, status: { not: 'APPROVED' } },
      });
      expect(prisma.scholarDocument.delete).toHaveBeenCalledWith({
        where: { document_id: 55 },
      });
      expect(audit.log).toHaveBeenCalledWith(
        7,
        'DOCUMENT_DELETED',
        stringMatching(/ID: 55/),
      );
      expect(result.success).toBe(true);
    });
  });

  describe('getMyDocuments', () => {
    it('throws NotFoundException when the scholar profile is missing', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue(null);

      await expect(service.getMyDocuments(7)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('filters by document type when given', async () => {
      await service.getMyDocuments(7, 'Form 138');

      expect(prisma.scholarDocument.findMany).toHaveBeenCalledWith(
        objectMatching({
          where: { scholar_profile_id: 11, document_type: 'Form 138' },
          orderBy: { uploaded_at: 'desc' },
        }),
      );
    });

    it('omits the document type filter when not provided', async () => {
      await service.getMyDocuments(7);

      const call = prisma.scholarDocument.findMany.mock.calls[0][0] as {
        where: Record<string, unknown>;
      };
      expect(call.where.document_type).toBeUndefined();
    });
  });

  describe('getDocumentDetail', () => {
    it('throws NotFoundException when the document does not exist', async () => {
      prisma.scholarDocument.findUnique.mockResolvedValue(null);

      await expect(service.getDocumentDetail(999)).rejects.toThrow(
        new NotFoundException('Document ID 999 not found.'),
      );
    });

    it('returns the document with the scholar profile include', async () => {
      const doc = { document_id: 55, scholar_profile: makeScholar() };
      prisma.scholarDocument.findUnique.mockResolvedValue(doc);

      const result = await service.getDocumentDetail(55);

      expect(result).toBe(doc);
      expect(prisma.scholarDocument.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ include: expect.any(Object) as object }),
      );
    });
  });

  describe('getPendingDocuments', () => {
    it('returns only grade-auditable scholar documents, newest first excluded', async () => {
      prisma.scholarDocument.findMany.mockResolvedValue([
        { document_id: 1, document_type: 'CCG', label: 'CCG' },
        { document_id: 2, document_type: 'TOR', label: 'TOR' },
        { document_id: 3, document_type: 'Form 138', label: 'Form 138' },
        { document_id: 4, document_type: 'Custom Upload', label: null },
        { document_id: 5, document_type: '', label: 'OFFICIAL_RECEIPT' },
      ]);

      const result = await service.getPendingDocuments();

      expect(prisma.scholarDocument.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: objectMatching({
            status: {
              in: [
                'PENDING',
                'PASSED_PRECHECK',
                'NEEDS_REUPLOAD',
                'STUDENT_CONFIRMED',
              ],
            },
          }),
          orderBy: { uploaded_at: 'asc' },
        }),
      );
      expect(result.map((d) => d.document_id)).toEqual([1, 4]);
    });
  });

  describe('getAllowedDocumentTypes', () => {
    it('throws NotFoundException when the scholar profile is missing', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue(null);

      await expect(service.getAllowedDocumentTypes(7)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('restricts 1st-year students to high school report cards', async () => {
      const result = await service.getAllowedDocumentTypes(7);

      expect(result).toEqual(
        objectMatching({
          current_year_level: 1,
          is_year_2_plus: false,
          required_document: 'Senior High School Form 138 / Form 9',
        }),
      );
      expect(result.allowed_types).toContain('Form 138');
      expect(result.allowed_types).not.toContain('TOR');
      expect(result.prohibited_types).toContain('TOR');
    });

    it('prompts 2nd to 4th year students to upload a TOR', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue(
        makeScholar({ current_year_level: 4 }),
      );

      const result = await service.getAllowedDocumentTypes(7);

      expect(result).toEqual(
        objectMatching({
          current_year_level: 4,
          is_year_2_plus: true,
          required_document: 'College Transcript of Records (TOR)',
        }),
      );
      expect(result.allowed_types).toContain('TOR');
      expect(result.prohibited_types).toContain('Form 138');
    });

    it('treats a missing year level as 1st year', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue(
        makeScholar({ current_year_level: null }),
      );

      const result = await service.getAllowedDocumentTypes(7);

      expect(result.current_year_level).toBe(1);
      expect(result.allowed_types).toContain('Form 138');
    });
  });
});
