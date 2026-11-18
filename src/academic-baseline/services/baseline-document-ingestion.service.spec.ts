import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { BaselineDocumentIngestionService } from './baseline-document-ingestion.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { CloudinaryService } from '../../cloudinary/cloudinary.service.js';
import { EventsGateway } from '../../events/events.gateway.js';
import { ProspectusOcrService } from '../prospectus-ocr.service.js';
import { AppCacheService } from '../../common/cache/app-cache.service.js';

// Asymmetric matchers are untyped; cast once so nested properties satisfy the linter.
const anyArg = (ctor: unknown) => expect.any(ctor) as unknown;
const objectMatching = (shape: Record<string, unknown>) =>
  expect.objectContaining(shape) as Record<string, unknown>;

const createPrismaMock = () => ({
  scholarProfile: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  scholarDocument: {
    create: vi.fn(),
    update: vi.fn(),
    findMany: vi.fn(),
  },
  academicChangeRequest: {
    findFirst: vi.fn(),
  },
  scholarProspectus: {
    upsert: vi.fn(),
    findUnique: vi.fn(),
  },
  prospectusSubject: {
    deleteMany: vi.fn(),
    createMany: vi.fn(),
    update: vi.fn(),
  },
});

const createAuditMock = () => ({ log: vi.fn() });
const createCloudinaryMock = () => ({ uploadBuffer: vi.fn() });
const createEventsMock = () => ({
  emitToUser: vi.fn(),
  emitToStaff: vi.fn(),
});
const createOcrMock = () => ({
  processProspectusExtraction: vi.fn(),
  normalizeSubjectCode: vi.fn().mockImplementation((code: string) =>
    (code || '')
      .trim()
      .toUpperCase()
      .replace(/[\s\-_./\\]+/g, ''),
  ),
});
const createCacheMock = () => ({ del: vi.fn() });

const makeFile = (overrides: Partial<Express.Multer.File> = {}) =>
  ({
    originalname: 'prospectus.pdf',
    mimetype: 'application/pdf',
    size: 2048,
    buffer: Buffer.from('file-contents'),
    ...overrides,
  }) as Express.Multer.File;

const makeScholar = (overrides: Record<string, unknown> = {}) => ({
  profile_id: 11,
  user_id: 7,
  first_name: 'Juan',
  last_name: 'Dela Cruz',
  course_of_study: 'BSIT',
  prospectus: {
    prospectus_id: 60,
    is_frozen: false,
    subjects: [
      {
        subject_id: 1,
        subject_code: 'cce 101',
        descriptive_title: 'Introduction to Computing',
        units: 3,
        year_level: 1,
        semester: '1st Semester',
      },
    ],
  },
  school_grading_system: {
    school_id: 1,
    grading_scale: 'NUMERIC_4_POINT',
  },
  ...overrides,
});

const makeExtractedProspectus = () => ({
  course_name: 'BS Information Technology',
  course_code: 'BSIT',
  curriculum_year: '2024-2025',
  total_units: 9,
  subjects: [
    {
      subject_code: 'CCE101',
      descriptive_title: 'Introduction to Computing',
      units: 3,
      year_level: 1,
      semester: '1st Semester',
      prerequisites: [],
      status: 'CREDITED',
      grade: 1.75,
      credited_term: '1st Year - 1st Semester',
      raw_grade_str: '1.75',
    },
    {
      subject_code: 'GE1',
      descriptive_title: 'Understanding the Self',
      units: 3,
      year_level: 1,
      semester: '1st Semester',
      prerequisites: [],
      status: 'UNTAKEN',
      grade: null,
      credited_term: null,
    },
  ],
});

describe('BaselineDocumentIngestionService', () => {
  let service: BaselineDocumentIngestionService;
  let prisma: ReturnType<typeof createPrismaMock>;
  let audit: ReturnType<typeof createAuditMock>;
  let cloudinary: ReturnType<typeof createCloudinaryMock>;
  let events: ReturnType<typeof createEventsMock>;
  let ocr: ReturnType<typeof createOcrMock>;
  let cache: ReturnType<typeof createCacheMock>;

  beforeEach(async () => {
    prisma = createPrismaMock();
    audit = createAuditMock();
    cloudinary = createCloudinaryMock();
    events = createEventsMock();
    ocr = createOcrMock();
    cache = createCacheMock();

    prisma.scholarProfile.findUnique.mockResolvedValue(makeScholar());
    prisma.scholarProfile.update.mockResolvedValue({ profile_id: 11 });
    cloudinary.uploadBuffer.mockResolvedValue({
      secure_url: 'https://cdn.test/prospectus.pdf',
    });
    ocr.processProspectusExtraction.mockResolvedValue(
      makeExtractedProspectus(),
    );
    prisma.scholarDocument.create.mockResolvedValue({ document_id: 50 });
    prisma.scholarDocument.update.mockResolvedValue({ document_id: 50 });
    prisma.scholarDocument.findMany.mockResolvedValue([]);
    prisma.academicChangeRequest.findFirst.mockResolvedValue(null);
    prisma.scholarProspectus.upsert.mockResolvedValue({
      prospectus_id: 60,
      scholar_profile_id: 11,
    });
    prisma.scholarProspectus.findUnique.mockResolvedValue({
      prospectus_id: 60,
      subjects: [],
      document: { document_id: 50 },
    });
    prisma.prospectusSubject.deleteMany.mockResolvedValue({ count: 0 });
    prisma.prospectusSubject.createMany.mockResolvedValue({ count: 2 });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BaselineDocumentIngestionService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: CloudinaryService, useValue: cloudinary },
        { provide: EventsGateway, useValue: events },
        { provide: ProspectusOcrService, useValue: ocr },
        { provide: AppCacheService, useValue: cache },
      ],
    }).compile();

    service = module.get<BaselineDocumentIngestionService>(
      BaselineDocumentIngestionService,
    );
  });

  it('is created by the Nest testing module', () => {
    expect(service).toBeDefined();
  });

  describe('uploadProspectus', () => {
    const files = [makeFile()];

    it('rejects an empty upload', async () => {
      await expect(service.uploadProspectus(7, [])).rejects.toThrow(
        new BadRequestException('At least one prospectus file is required.'),
      );
      await expect(
        service.uploadProspectus(
          7,
          undefined as unknown as Express.Multer.File[],
        ),
      ).rejects.toThrow(
        new BadRequestException('At least one prospectus file is required.'),
      );
      expect(prisma.scholarProfile.findUnique).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when the scholar profile is missing', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue(null);

      await expect(service.uploadProspectus(7, files)).rejects.toThrow(
        'Scholar profile not found.',
      );
    });

    it('forbids uploads when the baseline curriculum is frozen', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue(
        makeScholar({
          prospectus: {
            prospectus_id: 60,
            is_frozen: true,
          },
        }),
      );

      await expect(service.uploadProspectus(7, files)).rejects.toThrow(
        new ForbiddenException(
          'Your academic baseline curriculum is already frozen and cannot be modified.',
        ),
      );
    });

    it('stores the document and extracted curriculum draft', async () => {
      const result = await service.uploadProspectus(7, files);

      expect(cloudinary.uploadBuffer).toHaveBeenCalledWith(
        files[0].buffer,
        'viascholar/prospectus',
        expect.stringMatching(/^prospectus_11_\d+$/),
        'auto',
      );
      expect(ocr.processProspectusExtraction).toHaveBeenCalledWith([
        {
          buffer: files[0].buffer,
          mimeType: 'application/pdf',
          fileName: 'prospectus.pdf',
          fileUrl: '',
        },
      ]);
      expect(prisma.scholarDocument.create).toHaveBeenCalledWith({
        data: {
          scholar_profile_id: 11,
          document_type: 'PROSPECTUS',
          label: 'Curriculum Evaluation / Prospectus Sheet',
          file_name: 'prospectus.pdf',
          file_url: 'https://cdn.test/prospectus.pdf',
          file_size: '2.0 KB',
          file_type: 'pdf',
          status: 'PASSED_PRECHECK',
        },
      });
      expect(prisma.scholarProspectus.upsert).toHaveBeenCalledWith({
        where: { scholar_profile_id: 11 },
        create: {
          scholar_profile_id: 11,
          document_id: 50,
          curriculum_year: '2024-2025',
          course_code: 'BSIT',
          course_name: 'BS Information Technology',
          total_units: 9,
          status: 'DRAFT',
        },
        update: {
          document_id: 50,
          curriculum_year: '2024-2025',
          course_code: 'BSIT',
          course_name: 'BS Information Technology',
          total_units: 9,
          status: 'DRAFT',
        },
      });
      expect(prisma.prospectusSubject.deleteMany).toHaveBeenCalledWith({
        where: {
          prospectus_id: 60,
          status: { in: ['UNTAKEN', 'DRAFT'] },
        },
      });
      expect(prisma.prospectusSubject.createMany).toHaveBeenCalledWith({
        data: [
          {
            prospectus_id: 60,
            subject_code: 'CCE101',
            descriptive_title: 'Introduction to Computing',
            units: 3,
            year_level: 1,
            semester: '1st Semester',
            prerequisites: [],
            status: 'CREDITED',
            grade: 1.75,
            credited_term: '1st Year - 1st Semester',
            remarks: 'Extracted mark: 1.75',
          },
          {
            prospectus_id: 60,
            subject_code: 'GE1',
            descriptive_title: 'Understanding the Self',
            units: 3,
            year_level: 1,
            semester: '1st Semester',
            prerequisites: [],
            status: 'UNTAKEN',
            grade: undefined,
            credited_term: undefined,
            remarks: undefined,
          },
        ],
      });
      expect(prisma.scholarDocument.update).toHaveBeenCalledWith({
        where: { document_id: 50 },
        data: { extracted_data: anyArg(Object) },
      });
      expect(prisma.scholarProfile.update).toHaveBeenCalledWith({
        where: { profile_id: 11 },
        data: { academic_baseline_status: 'PENDING_HISTORICAL_CCG' },
      });
      expect(audit.log).toHaveBeenCalledWith(
        7,
        'PROSPECTUS_UPLOADED',
        'Scholar uploaded prospectus. Extracted 2 subjects (Total units: 9).',
      );
      expect(events.emitToUser).toHaveBeenCalledWith(
        7,
        'baseline:prospectus_processed',
        {
          prospectusId: 60,
          subjectsCount: 2,
          status: 'PENDING_HISTORICAL_CCG',
        },
      );
      expect(events.emitToStaff).toHaveBeenCalledWith(
        'baseline:prospectus_processed',
        {
          scholarProfileId: 11,
          studentName: 'Juan Dela Cruz',
          subjectsCount: 2,
        },
      );
      expect(cache.del).toHaveBeenCalledWith('baseline:scholar:7');
      expect(cache.del).toHaveBeenCalledWith('baseline:review:11');
      expect(cache.del).toHaveBeenCalledWith('dashboard:scholar:7');
      expect(result.academic_baseline_status).toBe('PENDING_HISTORICAL_CCG');
      expect(result.message).toContain('Prospectus extracted');
      expect(result.prospectus!.prospectus_id).toBe(60);
    });

    it('skips subject creation when the extraction is empty', async () => {
      ocr.processProspectusExtraction.mockResolvedValue({
        course_name: undefined,
        course_code: undefined,
        curriculum_year: undefined,
        total_units: undefined,
        subjects: [],
      });

      await service.uploadProspectus(7, files);

      expect(prisma.prospectusSubject.createMany).not.toHaveBeenCalled();
      expect(prisma.scholarProspectus.upsert).toHaveBeenCalledWith(
        objectMatching({
          create: objectMatching({
            curriculum_year: 'Current Catalog',
            course_code: undefined,
            course_name: 'BSIT',
            total_units: undefined,
            status: 'DRAFT',
          }),
        }),
      );
    });

    it('propagates OCR failures before writing to the database', async () => {
      ocr.processProspectusExtraction.mockRejectedValue(
        new Error('LlamaExtract unavailable'),
      );

      await expect(service.uploadProspectus(7, files)).rejects.toThrow(
        'LlamaExtract unavailable',
      );
      expect(prisma.scholarDocument.create).not.toHaveBeenCalled();
    });

    it('propagates Cloudinary failures before writing to the database', async () => {
      cloudinary.uploadBuffer.mockRejectedValue(
        new Error('Cloudinary upload failed'),
      );

      await expect(service.uploadProspectus(7, files)).rejects.toThrow(
        'Cloudinary upload failed',
      );
      expect(prisma.scholarDocument.create).not.toHaveBeenCalled();
    });

    describe('shift/transfer validation (PENDING_SHIFT_PROSPECTUS)', () => {
      const fiveOldSubjects = [
        { subject_code: 'IT101' },
        { subject_code: 'IT102' },
        { subject_code: 'IT103' },
        { subject_code: 'IT104' },
        { subject_code: 'IT105' },
      ];

      beforeEach(() => {
        prisma.scholarProfile.findUnique.mockResolvedValue(
          makeScholar({
            academic_baseline_status: 'PENDING_SHIFT_PROSPECTUS',
            course_of_study: 'BS Computer Science',
            prospectus: null,
          }),
        );
        prisma.academicChangeRequest.findFirst.mockResolvedValue({
          change_type: 'PROGRAM_SHIFT',
          current_course_of_study: 'BS Information Technology',
          requested_course_of_study: 'BS Computer Science',
          requested_program: {
            program_code: 'BSCS',
            program_name: 'BS Computer Science',
          },
        });
      });

      it('blocks uploading an empty-subject document during a shift', async () => {
        ocr.processProspectusExtraction.mockResolvedValue({
          course_name: 'BS Computer Science',
          subjects: [],
        });

        await expect(service.uploadProspectus(7, files)).rejects.toThrow(
          BadRequestException,
        );
        expect(prisma.scholarDocument.create).not.toHaveBeenCalled();
      });

      it('blocks re-uploading the exact same file hash from the previous prospectus', async () => {
        const crypto = await import('node:crypto');
        const expectedHash = crypto
          .createHash('sha256')
          .update(files[0].buffer)
          .digest('hex');

        prisma.scholarDocument.findMany.mockResolvedValue([
          { extracted_data: { file_hash: expectedHash } },
        ]);

        await expect(service.uploadProspectus(7, files)).rejects.toThrow(
          'You uploaded the exact same prospectus file from your previous program. Please upload the updated prospectus for your new program.',
        );
        expect(cloudinary.uploadBuffer).not.toHaveBeenCalled();
      });

      it('blocks uploading a prospectus that still matches the old program', async () => {
        ocr.processProspectusExtraction.mockResolvedValue({
          course_name: 'Bachelor of Science in Information Technology',
          course_code: 'BSIT',
          subjects: fiveOldSubjects,
        });

        await expect(service.uploadProspectus(7, files)).rejects.toThrow(
          /matches your previous program/i,
        );
        expect(prisma.scholarDocument.create).not.toHaveBeenCalled();
      });

      it('blocks uploading a prospectus for an unapproved third program', async () => {
        ocr.processProspectusExtraction.mockResolvedValue({
          course_name: 'Bachelor of Science in Accountancy',
          course_code: 'BSA',
          subjects: [{ subject_code: 'ACC101' }],
        });

        await expect(service.uploadProspectus(7, files)).rejects.toThrow(
          /does not match your Grantor-approved program/i,
        );
        expect(prisma.scholarDocument.create).not.toHaveBeenCalled();
      });

      it('blocks uploading a prospectus with >= 85% identical subjects to the old prospectus even if title is omitted', async () => {
        prisma.scholarDocument.findMany.mockResolvedValue([
          { extracted_data: { subjects: fiveOldSubjects } },
        ]);
        ocr.processProspectusExtraction.mockResolvedValue({
          course_name: '',
          course_code: '',
          subjects: fiveOldSubjects,
        });

        await expect(service.uploadProspectus(7, files)).rejects.toThrow(
          /same curriculum subjects as your previous program prospectus/i,
        );
        expect(prisma.scholarDocument.create).not.toHaveBeenCalled();
      });

      it('allows uploading a valid new program prospectus with credited subjects', async () => {
        prisma.scholarDocument.findMany.mockResolvedValue([
          {
            extracted_data: {
              course_name: 'BS Information Technology',
              course_code: 'BSIT',
              subjects: fiveOldSubjects,
            },
          },
        ]);
        ocr.processProspectusExtraction.mockResolvedValue({
          course_name: 'Bachelor of Science in Computer Science',
          course_code: 'BSCS',
          curriculum_year: '2025-2026',
          total_units: 12,
          subjects: [
            {
              subject_code: 'CS101',
              descriptive_title: 'Algorithms',
              units: 3,
              year_level: 1,
              semester: '1st Semester',
              prerequisites: [],
              status: 'CREDITED',
              grade: 1.5,
            },
          ],
        });

        const res = await service.uploadProspectus(7, files);
        expect(res.academic_baseline_status).toBe('PENDING_SHIFT_PROSPECTUS');
        expect(prisma.scholarDocument.create).toHaveBeenCalled();
      });
    });
  });

});
