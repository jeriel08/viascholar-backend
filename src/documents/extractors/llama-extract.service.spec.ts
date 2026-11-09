import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';

import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LlamaExtractService } from './llama-extract.service.js';

describe('LlamaExtractService', () => {
  let service: LlamaExtractService;
  let mockFilesCreate: Mock;
  let mockFilesDelete: Mock;
  let mockExtractCreate: Mock;
  let mockExtractGet: Mock;

  beforeEach(async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    mockFilesCreate = vi.fn().mockResolvedValue({ id: 'file-123' } as any);
    mockFilesDelete = vi.fn().mockResolvedValue(undefined as any);
    mockExtractCreate = vi.fn().mockResolvedValue({
      id: 'job-123',
      status: 'PENDING',
    } as any);
    mockExtractGet = vi.fn().mockResolvedValue({
      id: 'job-123',
      status: 'COMPLETED',
      extract_result: {
        detected_document_type: 'TRANSCRIPT_OF_RECORDS',
        student_name: 'DELA CRUZ, JUAN',
        school_name: 'University of Mindanao',
        course_name: 'BS Information Technology',
        grade_level: '1st Year',
        section: '11-ABM',
        grades: [
          {
            subject_code: 'IT 101',
            subject_name: 'Intro to IT',
            units: 3,
            grade: 1.5,
            semester: '1st Semester',
          },
        ],
      },
    } as any);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LlamaExtractService,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => {
              if (key === 'LLAMA_CLOUD_API_KEY') return 'test-llama-key';
              return null;
            },
          },
        },
      ],
    }).compile();

    service = module.get<LlamaExtractService>(LlamaExtractService);

    vi.spyOn(service as any, 'getClient').mockReturnValue({
      files: {
        create: mockFilesCreate,
        delete: mockFilesDelete,
      },
      extract: {
        create: mockExtractCreate,
        get: mockExtractGet,
      },
    } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should upload file and extract document grades successfully', async () => {
    const sampleFile = {
      buffer: Buffer.from('fake-file-bytes'),
      mimeType: 'application/pdf',
      fileName: 'tor_sample.pdf',
    };

    const result = await service.extractData(sampleFile, 'TOR');

    expect(mockFilesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: 'extract',
        external_file_id: 'tor_sample.pdf',
      }),
    );
    expect(mockExtractCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        file_input: 'file-123',
        configuration: expect.objectContaining({
          extraction_target: 'per_doc',
          tier: 'agentic',
        }) as unknown,
      }),
    );
    expect(mockExtractGet).toHaveBeenCalledWith('job-123');
    expect(mockFilesDelete).toHaveBeenCalledWith('file-123');

    expect(result.detected_document_type).toBe('TRANSCRIPT_OF_RECORDS');
    expect(result.student_name).toBe('DELA CRUZ, JUAN');
    expect(result.school_name).toBe('University of Mindanao');
    expect(result.section).toBe('11-ABM');
    expect(result.grades).toHaveLength(1);
    expect(result.grades?.[0].subject_code).toBe('IT 101');
  });

  it('should extract prospectus data successfully', async () => {
    mockExtractGet.mockResolvedValueOnce({
      id: 'job-123',
      status: 'COMPLETED',
      extract_result: {
        course_name: 'BS Information Technology',
        course_code: 'BSIT',
        curriculum_year: '2024-2025',
        total_units: 140,
        subjects: [
          {
            subject_code: 'IT 101',
            descriptive_title: 'Intro to IT',
            units: 3,
            year_level: 1,
            semester: '1st Semester',
            prerequisites: [],
          },
        ],
      },
    } as any);

    const sampleFile = {
      buffer: Buffer.from('fake-prospectus-bytes'),
      mimeType: 'application/pdf',
      fileName: 'prospectus.pdf',
    };

    const result = await service.extractProspectusData(sampleFile);

    expect(result.course_name).toBe('BS Information Technology');
    expect(result.course_code).toBe('BSIT');
    expect(result.subjects).toHaveLength(1);
    expect(result.subjects[0].subject_code).toBe('IT 101');
  });

  it('should merge multiple input files and extract all pages successfully', async () => {
    // Generate minimal valid PDF buffers for multi-file test
    const { PDFDocument } = await import('pdf-lib');
    const doc1 = await PDFDocument.create();
    doc1.addPage([100, 100]);
    const pdfBuf1 = Buffer.from(await doc1.save());

    const doc2 = await PDFDocument.create();
    doc2.addPage([100, 100]);
    const pdfBuf2 = Buffer.from(await doc2.save());

    const sampleFiles = [
      {
        buffer: pdfBuf1,
        mimeType: 'application/pdf',
        fileName: 'form138_page1.pdf',
      },
      {
        buffer: pdfBuf2,
        mimeType: 'application/pdf',
        fileName: 'form138_page2.pdf',
      },
    ];

    const result = await service.extractData(sampleFiles, 'Form 138');

    expect(mockFilesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: 'extract',
        external_file_id: expect.stringContaining(
          'form138_page1_merged_2pages.pdf',
        ) as unknown,
      }),
    );
    expect(mockExtractCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        file_input: 'file-123',
      }),
    );
    expect(result.student_name).toBe('DELA CRUZ, JUAN');
    expect(result.grades).toHaveLength(1);
  });
});

describe('LlamaExtractService extended paths', () => {
  let service2: LlamaExtractService;
  let mockFilesCreate2: Mock;
  let mockFilesDelete2: Mock;
  let mockExtractCreate2: Mock;
  let mockExtractGet2: Mock;

  beforeEach(async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    mockFilesCreate2 = vi.fn().mockResolvedValue({ id: 'file-ext' } as any);
    mockFilesDelete2 = vi.fn().mockResolvedValue(undefined as any);
    mockExtractCreate2 = vi.fn().mockResolvedValue({
      id: 'job-ext',
      status: 'PENDING',
    } as any);
    mockExtractGet2 = vi.fn().mockResolvedValue({
      id: 'job-ext',
      status: 'COMPLETED',
      extract_result: {
        detected_document_type: 'TRANSCRIPT_OF_RECORDS',
        student_name: 'JUAN DELA CRUZ',
        grades: [
          {
            subject_code: 'IT 101',
            units: 3,
            grade: 1.5,
            semester: '1st Semester',
          },
        ],
      },
    } as any);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LlamaExtractService,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              key === 'LLAMA_CLOUD_API_KEY' ? 'test-llama-key' : null,
          },
        },
      ],
    }).compile();

    service2 = module.get<LlamaExtractService>(LlamaExtractService);

    vi.spyOn(service2 as any, 'getClient').mockReturnValue({
      files: {
        create: mockFilesCreate2,
        delete: mockFilesDelete2,
      },
      extract: {
        create: mockExtractCreate2,
        get: mockExtractGet2,
      },
    } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws when the provided buffer is empty', async () => {
    await expect(
      service2.extractData(
        {
          buffer: undefined as unknown as Buffer,
          fileName: 'x.pdf',
          mimeType: 'application/pdf',
        },
        'TOR',
      ),
    ).rejects.toThrow('No valid file buffer provided for LlamaExtract.');
  });

  it('throws when the job completes without extract_result', async () => {
    mockExtractGet2.mockResolvedValue({
      id: 'job-ext',
      status: 'COMPLETED',
      extract_result: undefined,
    } as any);

    await expect(
      service2.extractData(
        {
          buffer: Buffer.from('x'),
          fileName: 'x.pdf',
          mimeType: 'application/pdf',
        },
        'TOR',
      ),
    ).rejects.toThrow('completed without extract_result');
  });

  it('throws with the job error_message when the job fails', async () => {
    mockExtractGet2.mockResolvedValue({
      id: 'job-ext',
      status: 'FAILED',
      error_message: 'Upstream OCR provider quota exceeded',
    } as any);

    await expect(
      service2.extractData(
        {
          buffer: Buffer.from('x'),
          fileName: 'x.pdf',
          mimeType: 'application/pdf',
        },
        'TOR',
      ),
    ).rejects.toThrow('Upstream OCR provider quota exceeded');
  });

  it('reuses the deduplication cache for identical inputs', async () => {
    const sampleFile = {
      buffer: Buffer.from('identical-bytes-for-cache-test'),
      mimeType: 'application/pdf',
      fileName: 'tor.pdf',
    };

    await service2.extractData(sampleFile, 'TOR');
    await service2.extractData(sampleFile, 'TOR');

    expect(mockFilesCreate2).toHaveBeenCalledTimes(1);
  }, 20000);

  describe('extractOfficialReceiptData remarks heuristics', () => {
    const runRemarks = async (raw: Record<string, unknown>) => {
      vi.spyOn(service2 as any, 'executeExtraction').mockResolvedValue(
        raw as any,
      );
      return service2.extractOfficialReceiptData({
        buffer: Buffer.from('x'),
        fileName: 'receipt.png',
        mimeType: 'image/png',
      });
    };

    it('infers the 1st semester from remarks text', async () => {
      const result = await runRemarks({
        remarks: 'tuition payment 1st sem AY 2026-2027',
      });

      expect(result.semester).toBe('1st Semester');
      expect(result.academic_year).toBe('2026-2027');
    });

    it('infers the 2nd semester and expands two-digit years', async () => {
      const result = await runRemarks({
        remarks: 'second sem 26-27',
      });

      expect(result.semester).toBe('2nd Semester');
      expect(result.academic_year).toBe('2026-2027');
    });

    it('infers Summer from midyear phrasing', async () => {
      const result = await runRemarks({ remarks: 'summer term tuition' });

      expect(result.semester).toBe('Summer');
    });

    it('infers the 3rd trimester from remarks text', async () => {
      const result = await runRemarks({ remarks: '3rd tri tuition' });

      expect(result.semester).toBe('3rd Trimester');
    });

    it('keeps extracted values when they are already present', async () => {
      const result = await runRemarks({
        remarks: 'tuition payment 1st sem 26-27',
        semester: '2nd Semester',
        academic_year: '2026-2027',
      });

      expect(result.semester).toBe('2nd Semester');
      expect(result.academic_year).toBe('2026-2027');
    });
  });
});
