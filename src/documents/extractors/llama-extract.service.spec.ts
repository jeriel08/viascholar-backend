import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { LlamaExtractService } from './llama-extract.service.js';

describe('LlamaExtractService', () => {
  let service: LlamaExtractService;
  let mockFilesCreate: jest.Mock;
  let mockFilesDelete: jest.Mock;
  let mockExtractCreate: jest.Mock;
  let mockExtractGet: jest.Mock;

  beforeEach(async () => {
    mockFilesCreate = jest.fn().mockResolvedValue({ id: 'file-123' } as any) as any;
    mockFilesDelete = jest.fn().mockResolvedValue(undefined as any) as any;
    mockExtractCreate = jest.fn().mockResolvedValue({
      id: 'job-123',
      status: 'PENDING',
    } as any) as any;
    mockExtractGet = jest.fn().mockResolvedValue({
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
    } as any) as any;

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

    jest.spyOn(service as any, 'getClient').mockReturnValue({
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
    jest.restoreAllMocks();
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
        }),
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
        external_file_id: expect.stringContaining('form138_page1_merged_2pages.pdf'),
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
