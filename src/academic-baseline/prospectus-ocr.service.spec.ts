import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ProspectusOcrService } from './prospectus-ocr.service.js';
import { LlamaExtractService } from '../documents/extractors/llama-extract.service.js';
import type { InputDocumentFile } from '../documents/extractors/document-extractor.interface.js';

describe('ProspectusOcrService', () => {
  let service: ProspectusOcrService;
  let llamaExtract: {
    extractProspectusData: ReturnType<typeof vi.fn>;
    extractData: ReturnType<typeof vi.fn>;
  };

  const input = [
    {
      buffer: Buffer.from('scan'),
      mimeType: 'application/pdf',
      fileName: 'prospectus.pdf',
      fileUrl: '',
    },
  ] as InputDocumentFile[];

  beforeEach(async () => {
    // OCR extraction logs progress on every call; keep the scenario output tidy.
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    llamaExtract = {
      extractProspectusData: vi.fn(),
      extractData: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProspectusOcrService,
        {
          provide: LlamaExtractService,
          useValue: llamaExtract,
        },
      ],
    }).compile();

    service = module.get<ProspectusOcrService>(ProspectusOcrService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is created by the Nest testing module', () => {
    expect(service).toBeDefined();
  });

  describe('normalizeSubjectCode', () => {
    it('strips whitespace, dashes, dots, slashes, and underscores', () => {
      expect(service.normalizeSubjectCode('IT 101')).toBe('IT101');
      expect(service.normalizeSubjectCode('cce - 102')).toBe('CCE102');
      expect(service.normalizeSubjectCode('IT.1_A/B')).toBe('IT1AB');
      expect(service.normalizeSubjectCode('IT 1a')).toBe('IT1A');
    });

    it('returns an empty string for a missing code', () => {
      expect(service.normalizeSubjectCode('')).toBe('');
      expect(service.normalizeSubjectCode(undefined as unknown as string)).toBe(
        '',
      );
    });

    it('converts trailing roman numerals after a letter into digits', () => {
      expect(service.normalizeSubjectCode('PAHF I')).toBe('PAHF1');
      expect(service.normalizeSubjectCode('NSTP II')).toBe('NSTP2');
      expect(service.normalizeSubjectCode('MATH III')).toBe('MATH3');
    });

    it('does not rewrite roman-looking letters when no letter precedes them', () => {
      expect(service.normalizeSubjectCode('123 I')).toBe('123I');
    });
  });

  describe('normalizeSemester', () => {
    it('maps first-semester and empty values to the default semester', () => {
      expect(service.normalizeSemester('1st Sem')).toBe('1st Semester');
      expect(service.normalizeSemester('')).toBe('1st Semester');
      expect(service.normalizeSemester('Unknown Term')).toBe('1st Semester');
    });

    it('maps second-semester wording to the second semester', () => {
      expect(service.normalizeSemester('Second Semester')).toBe('2nd Semester');
      expect(service.normalizeSemester('2nd Sem')).toBe('2nd Semester');
    });

    it('maps summer and midyear wording to Summer', () => {
      expect(service.normalizeSemester('Summer Term 2024')).toBe('Summer');
      expect(service.normalizeSemester('Midyear')).toBe('Summer');
    });

    it('maps third-term wording to the trimester label', () => {
      expect(service.normalizeSemester('3rd Term')).toBe('3rd Trimester');
      expect(service.normalizeSemester('Third Trimester')).toBe(
        '3rd Trimester',
      );
    });
  });

  describe('normalizeYearLevel', () => {
    it('accepts valid numeric year levels and floors decimals', () => {
      expect(service.normalizeYearLevel(1)).toBe(1);
      expect(service.normalizeYearLevel(4)).toBe(4);
      expect(service.normalizeYearLevel(2.9)).toBe(2);
    });

    it('extracts the first valid digit from string labels', () => {
      expect(service.normalizeYearLevel('1st Year')).toBe(1);
      expect(service.normalizeYearLevel('Year 3')).toBe(3);
      expect(service.normalizeYearLevel('6th Year')).toBe(6);
    });

    it('recognizes written year labels', () => {
      expect(service.normalizeYearLevel('Second Year')).toBe(2);
      expect(service.normalizeYearLevel('third')).toBe(3);
      expect(service.normalizeYearLevel('Fourth Year')).toBe(4);
      expect(service.normalizeYearLevel('fifth year')).toBe(5);
    });

    it('falls back to first year for unknown or out-of-range values', () => {
      expect(service.normalizeYearLevel(0)).toBe(1);
      expect(service.normalizeYearLevel(7)).toBe(1);
      expect(service.normalizeYearLevel('Kindergarten')).toBe(1);
      expect(service.normalizeYearLevel(null)).toBe(1);
    });
  });

  describe('processProspectusExtraction', () => {
    it('normalizes extracted subject fields and course metadata', async () => {
      llamaExtract.extractProspectusData.mockResolvedValue({
        course_name: 'BS Information Technology',
        course_code: 'BSIT',
        curriculum_year: '2024-2025',
        total_units: 12,
        subjects: [
          {
            subject_code: ' cce 101 ',
            descriptive_title: ' Introduction to Computing ',
            units: '4',
            year_level: '2nd Year',
            semester: 'second semester',
            prerequisites: [' CCE 100 ', '', '   '],
            status: 'passed',
            grade: '1.75',
            credited_term: '',
          },
        ],
      });

      const result = await service.processProspectusExtraction(input);

      expect(llamaExtract.extractProspectusData).toHaveBeenCalledWith(input);
      expect(result).toEqual({
        course_name: 'BS Information Technology',
        course_code: 'BSIT',
        curriculum_year: '2024-2025',
        total_units: 12,
        subjects: [
          {
            subject_code: 'CCE 101',
            descriptive_title: 'Introduction to Computing',
            units: 4,
            year_level: 2,
            semester: '2nd Semester',
            prerequisites: ['CCE 100'],
            grade: 1.75,
            status: 'CREDITED',
            credited_term: '2nd Year - 2nd Semester',
            raw_grade_str: '1.75',
          },
        ],
      });
    });

    it('applies defaults for missing subject and course fields', async () => {
      llamaExtract.extractProspectusData.mockResolvedValue({
        subjects: [
          {
            subject_code: 'GE 1',
            descriptive_title: '',
            units: 0,
            year_level: 'freshman',
            semester: '',
            prerequisites: 'not-an-array',
            grade: null,
          },
          {
            subject_code: '   ',
            descriptive_title: 'Should be skipped',
          },
        ],
      });

      const result = await service.processProspectusExtraction(input);

      expect(result.course_name).toBe('Degree Program');
      expect(result.course_code).toBeUndefined();
      expect(result.curriculum_year).toBe('Current Catalog');
      expect(result.total_units).toBe(3);
      expect(result.subjects).toHaveLength(1);
      expect(result.subjects[0]).toEqual({
        subject_code: 'GE 1',
        descriptive_title: 'GE 1',
        units: 3,
        year_level: 1,
        semester: '1st Semester',
        prerequisites: [],
        grade: null,
        status: 'UNTAKEN',
        credited_term: null,
        raw_grade_str: undefined,
      });
    });

    it('credits subjects with passing textual marks or a passing raw status', async () => {
      llamaExtract.extractProspectusData.mockResolvedValue({
        subjects: [
          { subject_code: 'A1', grade: 'PSD' },
          { subject_code: 'A2', grade: 'P' },
          { subject_code: 'A3', grade: 'PASSED' },
          { subject_code: 'A4', grade: 2.5 },
          {
            subject_code: 'A5',
            status: 'CREDITED',
            credited_term: 'Summer 2024',
          },
        ],
      });

      const result = await service.processProspectusExtraction(input);

      for (const subject of result.subjects) {
        expect(subject.status).toBe('CREDITED');
      }
      expect(result.subjects[4].credited_term).toBe('Summer 2024');
      expect(result.subjects[0].credited_term).toBe('1st Year - 1st Semester');
    });

    it('fails subjects with failing statuses or terminal numeric marks', async () => {
      llamaExtract.extractProspectusData.mockResolvedValue({
        subjects: [
          { subject_code: 'F1', status: 'FAILED' },
          { subject_code: 'F2', grade: 5 },
          { subject_code: 'F3', grade: 1 },
          { subject_code: 'F4', grade: 9 },
        ],
      });

      const result = await service.processProspectusExtraction(input);

      for (const subject of result.subjects) {
        expect(subject.status).toBe('FAILED');
      }
      expect(result.subjects[0].credited_term).toBe('1st Year - 1st Semester');
    });

    it('marks ongoing subjects as enrolled without a credited term', async () => {
      llamaExtract.extractProspectusData.mockResolvedValue({
        subjects: [
          { subject_code: 'E1', status: 'ENROLLED' },
          { subject_code: 'E2', status: 'ONGOING' },
          { subject_code: 'E3', status: 'IP' },
        ],
      });

      const result = await service.processProspectusExtraction(input);

      for (const subject of result.subjects) {
        expect(subject.status).toBe('ENROLLED');
        expect(subject.credited_term).toBeNull();
      }
    });

    it('leaves subjects untaken when no completion mark is present', async () => {
      llamaExtract.extractProspectusData.mockResolvedValue({
        subjects: [
          { subject_code: 'U1', grade: 0 },
          { subject_code: 'U2', grade: '' },
          { subject_code: 'U3' },
        ],
      });

      const result = await service.processProspectusExtraction(input);

      for (const subject of result.subjects) {
        expect(subject.status).toBe('UNTAKEN');
        expect(subject.credited_term).toBeNull();
      }
    });

    it('sums unit totals when the extractor omits an overall total', async () => {
      llamaExtract.extractProspectusData.mockResolvedValue({
        total_units: 0,
        subjects: [
          { subject_code: 'S1', units: 3.3 },
          { subject_code: 'S2', units: 3 },
        ],
      });

      const result = await service.processProspectusExtraction(input);

      expect(result.total_units).toBe(6.3);
    });

    it('prefers a positive extracted total over the calculated sum', async () => {
      llamaExtract.extractProspectusData.mockResolvedValue({
        total_units: '120',
        subjects: [{ subject_code: 'S1', units: 3 }],
      });

      const result = await service.processProspectusExtraction(input);

      expect(result.total_units).toBe(120);
    });

    it('returns an empty curriculum when the extractor finds no subjects', async () => {
      llamaExtract.extractProspectusData.mockResolvedValue({ subjects: [] });

      const result = await service.processProspectusExtraction(input);

      expect(result.subjects).toEqual([]);
      expect(result.total_units).toBe(0);
    });

    it('propagates extractor failures to the caller', async () => {
      llamaExtract.extractProspectusData.mockRejectedValue(
        new Error('LlamaExtract unavailable'),
      );

      await expect(service.processProspectusExtraction(input)).rejects.toThrow(
        'LlamaExtract unavailable',
      );
    });
  });

  describe('processHistoricalCcgExtraction', () => {
    it('requests historical TOR extraction with the provided documents', async () => {
      llamaExtract.extractData.mockResolvedValue({ grades: [] });

      await service.processHistoricalCcgExtraction(input);

      expect(llamaExtract.extractData).toHaveBeenCalledWith(
        input,
        'Historical TOR / Certified Copy of Grades',
      );
    });

    it('normalizes valid historical course records', async () => {
      llamaExtract.extractData.mockResolvedValue({
        grades: [
          {
            subject_code: ' cce 101 ',
            subject_name: ' Introduction to Computing ',
            units: '3',
            grade: '1.5',
            raw_status: 'PASSED',
            semester: '1st Semester',
          },
          {
            subject_code: 'GE-1',
            subject_name: '',
            units: null,
            grade: 2.0,
          },
        ],
      });

      const result = await service.processHistoricalCcgExtraction(input);

      expect(result).toEqual([
        {
          subject_code: 'CCE 101',
          subject_name: 'Introduction to Computing',
          units: 3,
          grade: 1.5,
          raw_status: 'PASSED',
          semester: '1st Semester',
        },
        {
          subject_code: 'GE-1',
          subject_name: undefined,
          units: undefined,
          grade: 2,
          raw_status: undefined,
          semester: undefined,
        },
      ]);
    });

    it('skips rows with missing codes or non-numeric grades', async () => {
      llamaExtract.extractData.mockResolvedValue({
        grades: [
          { subject_code: '', grade: 1.5 },
          { subject_code: 'MATH1', grade: 'INC' },
          { subject_code: 'MATH2' },
        ],
      });

      const result = await service.processHistoricalCcgExtraction(input);

      expect(result).toEqual([]);
    });

    it('returns an empty list when the extractor omits a grades array', async () => {
      llamaExtract.extractData.mockResolvedValue({ grades: 'invalid' });

      const result = await service.processHistoricalCcgExtraction(input);

      expect(result).toEqual([]);
    });

    it('propagates historical extractor failures to the caller', async () => {
      llamaExtract.extractData.mockRejectedValue(
        new Error('Historical extraction failed'),
      );

      await expect(
        service.processHistoricalCcgExtraction(input),
      ).rejects.toThrow('Historical extraction failed');
    });
  });
});
