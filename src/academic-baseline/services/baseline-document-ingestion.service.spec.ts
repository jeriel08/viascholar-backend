import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { BaselineDocumentIngestionService } from './baseline-document-ingestion.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { CloudinaryService } from '../../cloudinary/cloudinary.service.js';
import { SettingsService } from '../../settings/settings.service.js';
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
const createSettingsMock = () => ({ evaluateStudentGrade: vi.fn() });
const createEventsMock = () => ({
  emitToUser: vi.fn(),
  emitToStaff: vi.fn(),
});
const createOcrMock = () => ({
  processProspectusExtraction: vi.fn(),
  processHistoricalCcgExtraction: vi.fn(),
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
  let settings: ReturnType<typeof createSettingsMock>;
  let events: ReturnType<typeof createEventsMock>;
  let ocr: ReturnType<typeof createOcrMock>;
  let cache: ReturnType<typeof createCacheMock>;

  beforeEach(async () => {
    prisma = createPrismaMock();
    audit = createAuditMock();
    cloudinary = createCloudinaryMock();
    settings = createSettingsMock();
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
    prisma.prospectusSubject.update.mockResolvedValue({ subject_id: 1 });
    ocr.processHistoricalCcgExtraction.mockResolvedValue([
      {
        subject_code: 'CCE-101',
        subject_name: 'Introduction to Computing',
        units: 3,
        grade: 1.75,
        raw_status: 'P',
        semester: '1st Year - 1st Sem',
      },
      {
        subject_code: 'MATH101',
        subject_name: 'College Algebra',
        grade: 2.5,
        semester: '1st Year - 1st Sem',
      },
    ]);
    settings.evaluateStudentGrade.mockImplementation(
      (grade: number | string) => ({
        isPassing: Number(grade) <= 3.0,
      }),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BaselineDocumentIngestionService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: CloudinaryService, useValue: cloudinary },
        { provide: SettingsService, useValue: settings },
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
  });

  describe('uploadHistoricalCcg', () => {
    const files = [
      makeFile({ originalname: 'tor.pdf', mimetype: 'application/pdf' }),
    ];

    it('rejects an empty upload', async () => {
      await expect(service.uploadHistoricalCcg(7, [])).rejects.toThrow(
        new BadRequestException(
          'At least one historical grade transcript file is required.',
        ),
      );
      expect(prisma.scholarProfile.findUnique).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when the scholar profile is missing', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue(null);

      await expect(service.uploadHistoricalCcg(7, files)).rejects.toThrow(
        'Scholar profile not found.',
      );
    });

    it('requires a previously established prospectus', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue(
        makeScholar({ prospectus: null }),
      );

      await expect(service.uploadHistoricalCcg(7, files)).rejects.toThrow(
        new BadRequestException(
          'Please upload and establish your prospectus first before historical grades.',
        ),
      );
    });

    it('forbids uploads when the baseline is frozen', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue(
        makeScholar({
          prospectus: {
            prospectus_id: 60,
            is_frozen: true,
            subjects: [],
          },
        }),
      );

      await expect(service.uploadHistoricalCcg(7, files)).rejects.toThrow(
        new ForbiddenException(
          'Your academic baseline is frozen and cannot be modified.',
        ),
      );
    });

    it('credits passing courses and tags failed ones with the document', async () => {
      const result = await service.uploadHistoricalCcg(7, files);

      expect(cloudinary.uploadBuffer).toHaveBeenCalledWith(
        files[0].buffer,
        'viascholar/historical-ccg',
        expect.stringMatching(/^historical_ccg_11_\d+$/),
        'auto',
      );
      expect(ocr.processHistoricalCcgExtraction).toHaveBeenCalledWith([
        objectMatching({
          buffer: files[0].buffer,
          fileName: 'tor.pdf',
        }),
      ]);
      expect(prisma.scholarDocument.create).toHaveBeenCalledWith({
        data: objectMatching({
          scholar_profile_id: 11,
          document_type: 'HISTORICAL_CCG',
          status: 'PASSED_PRECHECK',
        }),
      });
      expect(settings.evaluateStudentGrade).toHaveBeenCalledWith(
        1.75,
        objectMatching({ grading_scale: 'NUMERIC_4_POINT' }),
      );
      expect(settings.evaluateStudentGrade).toHaveBeenCalledTimes(1);
      expect(prisma.prospectusSubject.update).toHaveBeenCalledTimes(1);
      expect(prisma.prospectusSubject.update).toHaveBeenCalledWith({
        where: { subject_id: 1 },
        data: {
          status: 'CREDITED',
          grade: 1.75,
          historical_document_id: 50,
          credited_term: '1st Year - 1st Sem',
        },
      });

      expect(result.matched_credited).toEqual([
        {
          subject_code: 'cce 101',
          grade: 1.75,
          title: 'Introduction to Computing',
        },
      ]);
      expect(result.unmapped_items).toEqual([
        { subject_code: 'MATH101', grade: 2.5 },
      ]);
      expect(result).toEqual(
        objectMatching({
          academic_baseline_status: 'PENDING_HISTORICAL_CCG',
        }),
      );

      expect(prisma.scholarDocument.update).toHaveBeenCalledWith({
        where: { document_id: 50 },
        data: {
          extracted_data: objectMatching({
            matched_credited: anyArg(Array),
          }),
        },
      });
      expect(prisma.scholarProfile.update).toHaveBeenCalledWith({
        where: { profile_id: 11 },
        data: { academic_baseline_status: 'PENDING_HISTORICAL_CCG' },
      });
      expect(cache.del).toHaveBeenCalledWith('baseline:scholar:7');
      expect(cache.del).toHaveBeenCalledWith('baseline:review:11');
      expect(cache.del).toHaveBeenCalledWith('dashboard:scholar:7');
    });

    it('credits unmatched courses into the unmapped list', async () => {
      ocr.processHistoricalCcgExtraction.mockResolvedValue([
        { subject_code: 'UNKNOWN101', grade: 1.0 },
      ]);

      const result = await service.uploadHistoricalCcg(7, files);

      expect(prisma.prospectusSubject.update).not.toHaveBeenCalled();
      expect(result.matched_credited).toEqual([]);
      expect(result.unmapped_items).toEqual([
        { subject_code: 'UNKNOWN101', grade: 1.0 },
      ]);
    });

    it('marks failing courses FAILED when the school config says so', async () => {
      ocr.processHistoricalCcgExtraction.mockResolvedValue([
        { subject_code: 'cce 101', grade: 5.0, semester: '2nd Year - 2nd Sem' },
      ]);
      settings.evaluateStudentGrade.mockReturnValue({ isPassing: false });

      const result = await service.uploadHistoricalCcg(7, files);

      expect(prisma.prospectusSubject.update).toHaveBeenCalledWith({
        where: { subject_id: 1 },
        data: objectMatching({
          status: 'FAILED',
          grade: 5.0,
          credited_term: '2nd Year - 2nd Sem',
        }),
      });
      expect(result.matched_credited).toHaveLength(1);
    });

    it('uses the pass-by-grade heuristic when no school config exists', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue(
        makeScholar({ school_grading_system: null }),
      );

      await service.uploadHistoricalCcg(7, files);

      expect(settings.evaluateStudentGrade).not.toHaveBeenCalled();
      expect(prisma.prospectusSubject.update).toHaveBeenCalledTimes(1);
      expect(prisma.prospectusSubject.update).toHaveBeenCalledWith({
        where: { subject_id: 1 },
        data: objectMatching({ status: 'CREDITED' }),
      });
    });

    it('falls back to the year-level term when the course has no semester', async () => {
      ocr.processHistoricalCcgExtraction.mockResolvedValue([
        { subject_code: 'cce 101', grade: 1.75 },
      ]);

      await service.uploadHistoricalCcg(7, files);

      expect(prisma.prospectusSubject.update).toHaveBeenCalledWith({
        where: { subject_id: 1 },
        data: objectMatching({
          credited_term: '1 Year - 1st Semester',
        }),
      });
    });

    it('credits 75-or-above grades and 1.0–3.0 grades in the heuristic', async () => {
      prisma.scholarProfile.findUnique.mockResolvedValue(
        makeScholar({
          school_grading_system: null,
          prospectus: {
            prospectus_id: 60,
            is_frozen: false,
            subjects: [
              {
                subject_id: 1,
                subject_code: 'a',
                descriptive_title: 'A',
                units: 3,
                year_level: 1,
                semester: '1st Semester',
              },
              {
                subject_id: 2,
                subject_code: 'b',
                descriptive_title: 'B',
                units: 3,
                year_level: 1,
                semester: '1st Semester',
              },
              {
                subject_id: 3,
                subject_code: 'c',
                descriptive_title: 'C',
                units: 3,
                year_level: 1,
                semester: '1st Semester',
              },
            ],
          },
        }),
      );
      ocr.processHistoricalCcgExtraction.mockResolvedValue([
        { subject_code: 'a', grade: 80, semester: 'X' },
        { subject_code: 'b', grade: 2.5, semester: 'Y' },
        { subject_code: 'c', grade: 5.0, semester: 'Z' },
      ]);

      await service.uploadHistoricalCcg(7, files);

      const calls = prisma.prospectusSubject.update.mock.calls.map((call) => {
        const arg = call[0] as { data: { status: string } };
        return arg.data.status;
      });
      expect(calls).toEqual(['CREDITED', 'CREDITED', 'FAILED']);
    });

    it('propagates OCR failures before writing to the database', async () => {
      ocr.processHistoricalCcgExtraction.mockRejectedValue(
        new Error('TOR parse failed'),
      );

      await expect(service.uploadHistoricalCcg(7, files)).rejects.toThrow(
        'TOR parse failed',
      );
      expect(prisma.scholarDocument.create).not.toHaveBeenCalled();
    });

    it('propagates Cloudinary failures before writing to the database', async () => {
      cloudinary.uploadBuffer.mockRejectedValue(
        new Error('Cloudinary upload failed'),
      );

      await expect(service.uploadHistoricalCcg(7, files)).rejects.toThrow(
        'Cloudinary upload failed',
      );
      expect(prisma.scholarDocument.create).not.toHaveBeenCalled();
    });
  });
});
