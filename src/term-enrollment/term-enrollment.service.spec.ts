import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BadRequestException, Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { EnrollmentAuditEngineService } from './services/enrollment-audit-engine.service.js';
import { EnrollmentOcrService } from './services/enrollment-ocr.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { LlamaExtractService } from '../documents/extractors/llama-extract.service.js';

describe('TermEnrollment Services', () => {
  let ocrService: EnrollmentOcrService;
  let auditEngine: EnrollmentAuditEngineService;

  const mockPrisma = {
    scholarProspectus: {
      findUnique: vi.fn<any>(),
    },
    scholarProfile: {
      findUnique: vi.fn<any>(),
    },
  };

  const mockLlamaExtract = {
    extractEnrollmentCorData: vi.fn(),
    extractEnrollmentSoaData: vi.fn(),
    extractConsolidatedEnrollmentData: vi.fn(),
  };

  const ocrInput = {
    buffer: Buffer.from('x'),
    mimeType: 'application/pdf',
    fileName: 'cor.pdf',
  };

  beforeEach(async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EnrollmentOcrService,
        EnrollmentAuditEngineService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: LlamaExtractService, useValue: mockLlamaExtract },
      ],
    }).compile();

    ocrService = module.get<EnrollmentOcrService>(EnrollmentOcrService);
    auditEngine = module.get<EnrollmentAuditEngineService>(
      EnrollmentAuditEngineService,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('EnrollmentOcrService normalization', () => {
    it('normalizes subject codes by removing separators and converting roman numerals', () => {
      expect(ocrService.normalizeSubjectCode('IT - 101 A')).toBe('IT101A');
      expect(ocrService.normalizeSubjectCode('cce 102')).toBe('CCE102');
      expect(ocrService.normalizeSubjectCode('MATH III')).toBe('MATH3');
      expect(ocrService.normalizeSubjectCode('MATH II')).toBe('MATH2');
      expect(ocrService.normalizeSubjectCode('PHYS I')).toBe('PHYS1');
      expect(ocrService.normalizeSubjectCode('_IT_/_101_')).toBe('IT101');
      expect(ocrService.normalizeSubjectCode('')).toBe('');
      expect(
        ocrService.normalizeSubjectCode(undefined as unknown as string),
      ).toBe('');
    });

    it('normalizes semester names to the canonical term labels', () => {
      expect(ocrService.normalizeSemester('1st Sem')).toBe('1st Semester');
      expect(ocrService.normalizeSemester('2nd Semester 2026')).toBe(
        '2nd Semester',
      );
      expect(ocrService.normalizeSemester('Second Semester')).toBe(
        '2nd Semester',
      );
      expect(ocrService.normalizeSemester('Summer Term')).toBe('Summer');
      expect(ocrService.normalizeSemester('Midyear')).toBe('Summer');
      expect(ocrService.normalizeSemester('3rd Trimester')).toBe(
        '3rd Trimester',
      );
      expect(ocrService.normalizeSemester('Third Term')).toBe('3rd Trimester');
      expect(ocrService.normalizeSemester('')).toBe('1st Semester');
      expect(ocrService.normalizeSemester('Unknown')).toBe('1st Semester');
    });

    it('normalizes numeric and textual year levels', () => {
      expect(ocrService.normalizeYearLevel(4)).toBe(4);
      expect(ocrService.normalizeYearLevel(3.9)).toBe(3);
      expect(ocrService.normalizeYearLevel(0)).toBe(1);
      expect(ocrService.normalizeYearLevel(7)).toBe(1);
      expect(ocrService.normalizeYearLevel('3rd Year')).toBe(3);
      expect(ocrService.normalizeYearLevel('Year 4')).toBe(4);
      expect(ocrService.normalizeYearLevel('first year')).toBe(1);
      expect(ocrService.normalizeYearLevel('second year')).toBe(2);
      expect(ocrService.normalizeYearLevel('third year')).toBe(3);
      expect(ocrService.normalizeYearLevel('fourth year')).toBe(4);
      expect(ocrService.normalizeYearLevel('fifth year')).toBe(5);
      expect(ocrService.normalizeYearLevel('unclassified')).toBe(1);
      expect(ocrService.normalizeYearLevel(undefined)).toBe(1);
    });
  });

  describe('EnrollmentOcrService.parseCor', () => {
    it('rejects a statement of account uploaded as a COR', async () => {
      mockLlamaExtract.extractEnrollmentCorData.mockResolvedValue({
        detected_document_type: 'STATEMENT_OF_ACCOUNT',
      });

      await expect(ocrService.parseCor(ocrInput)).rejects.toThrow(
        new BadRequestException(
          'The uploaded document is a Statement of Account or Tuition Fee Assessment. Please upload your Proof of Enrolled Subjects (Certificate of Registration / Class Schedule) in this input, or switch to Consolidated mode if your form contains both.',
        ),
      );
    });

    it('rejects an assessment form that is not also a class schedule', async () => {
      mockLlamaExtract.extractEnrollmentCorData.mockResolvedValue({
        is_assessment_form: true,
        is_class_schedule: false,
      });

      await expect(ocrService.parseCor(ocrInput)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects an unrelated document type', async () => {
      mockLlamaExtract.extractEnrollmentCorData.mockResolvedValue({
        detected_document_type: 'OTHER',
      });

      await expect(ocrService.parseCor(ocrInput)).rejects.toThrow(
        new BadRequestException(
          'The uploaded document does not appear to be an official Certificate of Registration or Class Schedule. Please upload a valid enrollment document.',
        ),
      );
    });

    it('rejects an empty subject list', async () => {
      mockLlamaExtract.extractEnrollmentCorData.mockResolvedValue({
        detected_document_type: 'CERTIFICATE_OF_REGISTRATION',
        subjects: [],
      });

      await expect(ocrService.parseCor(ocrInput)).rejects.toThrow(
        new BadRequestException(
          'The uploaded document does not appear to be an official Certificate of Registration or Class Schedule. Please upload a valid enrollment document.',
        ),
      );
    });

    it('rejects subjects whose codes are all blank after normalization', async () => {
      mockLlamaExtract.extractEnrollmentCorData.mockResolvedValue({
        subjects: [
          { subject_code: '   ', descriptive_title: 'Blank', units: 3 },
          { subject_code: null, descriptive_title: 'Missing', units: 3 },
        ],
      });

      await expect(ocrService.parseCor(ocrInput)).rejects.toThrow(
        new BadRequestException(
          'No registered courses or class schedule were detected in the uploaded file. Please make sure to upload an official Certificate of Registration (COR) or Class Schedule showing your enrolled subjects.',
        ),
      );
    });

    it('rejects a tuition ledger that was misread as a class schedule', async () => {
      mockLlamaExtract.extractEnrollmentCorData.mockResolvedValue({
        subjects: [
          {
            subject_code: 'TUITION FEE',
            descriptive_title: 'Tuition',
            units: 0,
          },
          {
            subject_code: 'MISC',
            descriptive_title: 'Miscellaneous Fee',
            units: 0,
          },
        ],
      });

      await expect(ocrService.parseCor(ocrInput)).rejects.toThrow(
        new BadRequestException(
          'The uploaded document appears to be a tuition billing ledger rather than an enrolled class schedule. Please upload your Certificate of Registration or Class Schedule.',
        ),
      );
    });

    it('turns extractor errors or null results into a BadRequestException instead of 500', async () => {
      mockLlamaExtract.extractEnrollmentCorData.mockRejectedValueOnce(
        new Error('LlamaExtract job 123 ended with status FAILED'),
      );
      await expect(ocrService.parseCor(ocrInput)).rejects.toThrow(
        BadRequestException,
      );

      mockLlamaExtract.extractEnrollmentCorData.mockResolvedValueOnce(null);
      await expect(ocrService.parseCor(ocrInput)).rejects.toThrow(
        BadRequestException,
      );

      mockLlamaExtract.extractEnrollmentCorData.mockResolvedValueOnce({
        subjects: 'not-an-array',
      });
      await expect(ocrService.parseCor(ocrInput)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('normalizes academic subjects, drops fee rows, and computes the unit total', async () => {
      mockLlamaExtract.extractEnrollmentCorData.mockResolvedValue({
        detected_document_type: 'CERTIFICATE_OF_REGISTRATION',
        student_name: ' Ana Cruz ',
        student_number: '2020-001',
        school_name: 'UM',
        course_name: 'BSIT',
        academic_year: '2026-2027',
        semester: 'Second Semester',
        year_level: '3rd Year',
        total_units: 0,
        subjects: [
          {
            subject_code: ' it 101 ',
            descriptive_title: 'Intro to IT',
            units: '3',
          },
          { subject_code: 'MATH 2', units: 0 },
          {
            subject_code: 'TUITION FEE',
            descriptive_title: 'Tuition',
            units: 0,
          },
          { subject_code: '', descriptive_title: 'Dropped', units: 3 },
        ],
      });

      const result = await ocrService.parseCor(ocrInput);

      expect(result).toEqual({
        student_name: ' Ana Cruz ',
        student_number: '2020-001',
        school_name: 'UM',
        course_name: 'BSIT',
        academic_year: '2026-2027',
        semester: '2nd Semester',
        year_level: 3,
        total_units: 6,
        subjects: [
          {
            subject_code: 'IT 101',
            descriptive_title: 'Intro to IT',
            section: undefined,
            schedule: undefined,
            room: undefined,
            units: 3,
          },
          {
            subject_code: 'MATH 2',
            descriptive_title: 'MATH 2',
            section: undefined,
            schedule: undefined,
            room: undefined,
            units: 3,
          },
        ],
      });
    });

    it('prefers the OCR total units when it is positive', async () => {
      mockLlamaExtract.extractEnrollmentCorData.mockResolvedValue({
        total_units: 18,
        subjects: [
          { subject_code: 'IT 101', descriptive_title: 'Intro', units: 3 },
        ],
      });

      const result = await ocrService.parseCor(ocrInput);

      expect(result.total_units).toBe(18);
    });

    it('passes through optional section, schedule, and room fields', async () => {
      mockLlamaExtract.extractEnrollmentCorData.mockResolvedValue({
        total_units: 3,
        subjects: [
          {
            subject_code: 'IT 101',
            descriptive_title: 'Intro',
            section: ' A ',
            schedule: ' MWF 8-9 ',
            room: ' 301 ',
            units: 3,
          },
        ],
      });

      const result = await ocrService.parseCor(ocrInput);

      expect(result.subjects[0]).toEqual(
        expect.objectContaining({
          section: 'A',
          schedule: 'MWF 8-9',
          room: '301',
        }),
      );
    });

    it('extracts Summer single-year academic_year and separates UM numeric class codes from subject codes', async () => {
      mockLlamaExtract.extractEnrollmentCorData.mockResolvedValue({
        detected_document_type: 'CERTIFICATE_OF_REGISTRATION',
        student_name: 'Sanao, Jeriel Lian',
        student_number: '543797',
        academic_year: undefined,
        semester: 'Summer 2024',
        year_level: '4th Year',
        total_units: 9.0,
        subjects: [
          {
            subject_code: '11040',
            descriptive_title: 'GE 5 SCIENCE, TECHNOLOGY AND SOCIETY',
            units: 3.0,
          },
          {
            subject_code: '11065',
            descriptive_title: 'GE\n11 THE ENTREPRENEURIAL MINDS',
            units: 3.0,
          },
          {
            subject_code: 'GE 20',
            descriptive_title: 'GE 20 READING VISUAL ARTS',
            section: '11066',
            units: 3.0,
          },
        ],
      });

      const result = await ocrService.parseCor(ocrInput);

      expect(result.academic_year).toBe('2024');
      expect(result.semester).toBe('Summer');
      expect(result.year_level).toBe(4);
      expect(result.subjects).toEqual([
        {
          subject_code: 'GE 5',
          descriptive_title: 'SCIENCE, TECHNOLOGY AND SOCIETY',
          section: '11040',
          schedule: undefined,
          room: undefined,
          units: 3,
        },
        {
          subject_code: 'GE 11',
          descriptive_title: 'THE ENTREPRENEURIAL MINDS',
          section: '11065',
          schedule: undefined,
          room: undefined,
          units: 3,
        },
        {
          subject_code: 'GE 20',
          descriptive_title: 'READING VISUAL ARTS',
          section: '11066',
          schedule: undefined,
          room: undefined,
          units: 3,
        },
      ]);
    });
  });

  describe('EnrollmentOcrService.parseSoa', () => {
    it('rejects a COR uploaded as a SOA', async () => {
      mockLlamaExtract.extractEnrollmentSoaData.mockResolvedValue({
        detected_document_type: 'CERTIFICATE_OF_REGISTRATION',
      });

      await expect(ocrService.parseSoa(ocrInput)).rejects.toThrow(
        new BadRequestException(
          'The uploaded document is a Certificate of Registration or Class Schedule, not a Statement of Account. Please upload your Tuition Fee Assessment, Statement of Account (SOA), or Student Ledger in this input.',
        ),
      );
    });

    it('rejects a class schedule that is not an assessment form', async () => {
      mockLlamaExtract.extractEnrollmentSoaData.mockResolvedValue({
        is_class_schedule: true,
        is_assessment_form: false,
      });

      await expect(ocrService.parseSoa(ocrInput)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects an unrelated document type', async () => {
      mockLlamaExtract.extractEnrollmentSoaData.mockResolvedValue({
        detected_document_type: 'OTHER',
      });

      await expect(ocrService.parseSoa(ocrInput)).rejects.toThrow(
        new BadRequestException(
          'The uploaded document does not appear to be an official Statement of Account or Tuition Assessment. Please upload a valid billing or ledger document.',
        ),
      );
    });

    it('rejects a document with neither a balance nor a fee breakdown', async () => {
      mockLlamaExtract.extractEnrollmentSoaData.mockResolvedValue({
        total_assessment: 0,
      });

      await expect(ocrService.parseSoa(ocrInput)).rejects.toThrow(
        new BadRequestException(
          'No tuition assessment balance or fee charges were detected in the uploaded file. Please upload an official Statement of Account (SOA), Tuition Fee Assessment, or Student Ledger.',
        ),
      );
    });

    it('normalizes the fee breakdown and falls back to the total assessment for the net due', async () => {
      mockLlamaExtract.extractEnrollmentSoaData.mockResolvedValue({
        student_name: 'Ana Cruz',
        student_number: '2020-001',
        school_name: 'UM',
        academic_year: '2026-2027',
        semester: 'Second Semester',
        assessment_date: '2026-06-01',
        total_assessment: '12000',
        tuition_fee: '9000',
        lab_fees: 1500,
        misc_fees: null,
        other_fees: undefined,
        previous_balance: 0,
        discounts: 500,
        net_balance_due: null,
      });

      const result = await ocrService.parseSoa(ocrInput);

      expect(result).toEqual({
        student_name: 'Ana Cruz',
        student_number: '2020-001',
        school_name: 'UM',
        academic_year: '2026-2027',
        semester: '2nd Semester',
        assessment_date: '2026-06-01',
        total_assessment: 12000,
        tuition_fee: 9000,
        lab_fees: 1500,
        misc_fees: undefined,
        other_fees: undefined,
        previous_balance: 0,
        discounts: 500,
        net_balance_due: 12000,
      });
    });

    it('accepts a zero assessment when a fee breakdown is present', async () => {
      mockLlamaExtract.extractEnrollmentSoaData.mockResolvedValue({
        total_assessment: 0,
        tuition_fee: '5000',
      });

      const result = await ocrService.parseSoa(ocrInput);

      expect(result.total_assessment).toBe(0);
      expect(result.tuition_fee).toBe(5000);
      expect(result.net_balance_due).toBe(0);
    });

    it('rejects non-numeric fee strings like N/A and wraps extractor errors as BadRequestException', async () => {
      mockLlamaExtract.extractEnrollmentSoaData.mockResolvedValueOnce({
        total_assessment: 'N/A',
        tuition_fee: 'N/A',
      });
      await expect(ocrService.parseSoa(ocrInput)).rejects.toThrow(
        BadRequestException,
      );

      mockLlamaExtract.extractEnrollmentSoaData.mockRejectedValueOnce(
        new Error('LlamaExtract job 456 ended with status FAILED'),
      );
      await expect(ocrService.parseSoa(ocrInput)).rejects.toThrow(
        BadRequestException,
      );

      mockLlamaExtract.extractEnrollmentSoaData.mockResolvedValueOnce(null);
      await expect(ocrService.parseSoa(ocrInput)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('EnrollmentOcrService.parseConsolidated', () => {
    it('rejects a consolidated document without subjects', async () => {
      mockLlamaExtract.extractConsolidatedEnrollmentData.mockResolvedValue({
        subjects: [],
      });

      await expect(ocrService.parseConsolidated(ocrInput)).rejects.toThrow(
        new BadRequestException(
          'No enrolled subjects found in the consolidated document. Please ensure your form contains both your registered courses and tuition assessment.',
        ),
      );
    });

    it('rejects a consolidated document without an assessment', async () => {
      mockLlamaExtract.extractConsolidatedEnrollmentData.mockResolvedValue({
        subjects: [
          { subject_code: 'IT 101', descriptive_title: 'Intro', units: 3 },
        ],
        total_assessment: 0,
      });

      await expect(ocrService.parseConsolidated(ocrInput)).rejects.toThrow(
        new BadRequestException(
          'No tuition assessment balance found in the consolidated document. If your school issues separate documents for class schedule and tuition billing, please turn off Consolidated mode.',
        ),
      );
    });

    it('normalizes subjects, units, fees, and semester for a consolidated form', async () => {
      mockLlamaExtract.extractConsolidatedEnrollmentData.mockResolvedValue({
        student_name: 'Ana Cruz',
        student_number: '2020-001',
        school_name: 'UM',
        course_name: 'BSIT',
        academic_year: '2026-2027',
        semester: 'Third Trimester',
        year_level: 2,
        total_units: 0,
        assessment_date: '2026-06-01',
        total_assessment: '15000',
        tuition_fee: '10000',
        lab_fees: 2500,
        misc_fees: 500,
        other_fees: 1000,
        previous_balance: 250,
        discounts: 750,
        net_balance_due: null,
        subjects: [
          { subject_code: 'it 101', descriptive_title: 'Intro', units: 3 },
          { subject_code: 'IT 102', units: '4' },
        ],
      });

      const result = await ocrService.parseConsolidated(ocrInput);

      expect(result).toEqual({
        student_name: 'Ana Cruz',
        student_number: '2020-001',
        school_name: 'UM',
        course_name: 'BSIT',
        academic_year: '2026-2027',
        semester: '3rd Trimester',
        year_level: 2,
        total_units: 7,
        assessment_date: '2026-06-01',
        total_assessment: 15000,
        tuition_fee: 10000,
        lab_fees: 2500,
        misc_fees: 500,
        other_fees: 1000,
        previous_balance: 250,
        discounts: 750,
        net_balance_due: 15000,
        subjects: [
          {
            subject_code: 'IT 101',
            descriptive_title: 'Intro',
            section: undefined,
            schedule: undefined,
            room: undefined,
            units: 3,
          },
          {
            subject_code: 'IT 102',
            descriptive_title: 'IT 102',
            section: undefined,
            schedule: undefined,
            room: undefined,
            units: 4,
          },
        ],
      });
    });

    it('rejects OTHER document type and wraps extractor failures as BadRequestException', async () => {
      mockLlamaExtract.extractConsolidatedEnrollmentData.mockResolvedValueOnce({
        detected_document_type: 'OTHER',
      });
      await expect(ocrService.parseConsolidated(ocrInput)).rejects.toThrow(
        BadRequestException,
      );

      mockLlamaExtract.extractConsolidatedEnrollmentData.mockRejectedValueOnce(
        new Error('LlamaExtract job 789 ended with status FAILED'),
      );
      await expect(ocrService.parseConsolidated(ocrInput)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('EnrollmentAuditEngineService code helpers', () => {
    it('normalizes subject codes consistently with the OCR service', () => {
      expect(auditEngine.normalizeSubjectCode('IT - 101 A')).toBe('IT101A');
      expect(auditEngine.normalizeSubjectCode('MATH III')).toBe('MATH3');
      expect(auditEngine.normalizeSubjectCode('')).toBe('');
      expect(
        auditEngine.normalizeSubjectCode(undefined as unknown as string),
      ).toBe('');
    });

    it('strips LAB, LEC, and trailing lab suffixes to derive the base code', () => {
      expect(auditEngine.getBaseSubjectCode('IT 101 LAB')).toBe('IT101');
      expect(auditEngine.getBaseSubjectCode('IT 101 LEC')).toBe('IT101');
      expect(auditEngine.getBaseSubjectCode('IT 101L')).toBe('IT101');
      expect(auditEngine.getBaseSubjectCode('IT 101/L')).toBe('IT101');
      expect(auditEngine.getBaseSubjectCode('MATH 2')).toBe('MATH2');
      expect(auditEngine.getBaseSubjectCode('')).toBe('');
      expect(
        auditEngine.getBaseSubjectCode(undefined as unknown as string),
      ).toBe('');
    });

    it('returns no prerequisite tokens for empty or unsupported input', () => {
      expect(auditEngine.parsePrerequisiteTokens(undefined)).toEqual([]);
      expect(auditEngine.parsePrerequisiteTokens(null)).toEqual([]);
      expect(auditEngine.parsePrerequisiteTokens('')).toEqual([]);
      expect(auditEngine.parsePrerequisiteTokens({})).toEqual([]);
      expect(auditEngine.parsePrerequisiteTokens(42)).toEqual([]);
    });

    it('accepts a single prerequisite string', () => {
      expect(auditEngine.parsePrerequisiteTokens('IT 101')).toEqual(['IT 101']);
    });

    it('filters academic-standing, empty, and placeholder tokens', () => {
      expect(
        auditEngine.parsePrerequisiteTokens([
          'None',
          'N/A',
          'n.a.',
          '-',
          'nil',
          'null',
          'L',
          'lab',
          'lec',
          'no prerequisites',
          '4th Year Standing',
          'Permission of Adviser',
          'Regular',
          '3 Units',
          'none / n/a',
          'IT 101',
        ]),
      ).toEqual(['IT 101']);
    });

    it('splits prerequisite lists on commas, semicolons, ampersands, pipes, and conjunctions', () => {
      expect(
        auditEngine.parsePrerequisiteTokens(
          'IT 101, MATH 2; PHYS 3 & CHEM 4 | BIO 5 and ENG 6 or HIST 7 / FIL 8',
        ),
      ).toEqual([
        'IT 101',
        'MATH 2',
        'PHYS 3',
        'CHEM 4',
        'BIO 5',
        'ENG 6',
        'HIST 7',
        'FIL 8',
      ]);
    });

    it('keeps slash-lab tokens that are not surrounded by spaces', () => {
      expect(auditEngine.parsePrerequisiteTokens('PHYS 101/L')).toEqual([
        'PHYS 101/L',
      ]);
    });

    it('skips non-string entries in an array', () => {
      expect(
        auditEngine.parsePrerequisiteTokens(['MATH 2', 42, null, 'IT 101']),
      ).toEqual(['MATH 2', 'IT 101']);
    });

    it('treats an item containing a placeholder keyword as a non-prerequisite requirement', () => {
      expect(
        auditEngine.parsePrerequisiteTokens('IT 101 and N/A;None'),
      ).toEqual([]);
    });
  });

  describe('EnrollmentAuditEngineService.runAudit', () => {
    const enrolled = (
      subjectCode: string,
      units = 3,
      title = 'Subject',
    ): {
      subject_code: string;
      descriptive_title: string;
      units: number;
    } => ({ subject_code: subjectCode, descriptive_title: title, units });

    it('flags unlisted subjects as off-track but ignores underload as a blocking flag', async () => {
      mockPrisma.scholarProspectus.findUnique.mockResolvedValue(null);

      const audit = await auditEngine.runAudit(10, [
        enrolled('IT 999', 3, 'Elective'),
      ]);

      expect(audit.all_cleared).toBe(false);
      expect(audit.flags).toEqual([
        'OFF_TRACK_SUBJECT:IT 999',
        'UNDERLOAD_UNITS',
      ]);
      expect(audit.total_units).toBe(3);
      expect(audit.overload_flag).toBe(false);
      expect(audit.underload_flag).toBe(true);
      expect(audit.subjects_audit[0]).toEqual({
        subject_code: 'IT 999',
        descriptive_title: 'Elective',
        units: 3,
        section: undefined,
        schedule: undefined,
        room: undefined,
        status: 'OFF_TRACK',
        remarks: 'Subject code not found in the frozen curriculum baseline.',
      });
    });

    it('approves on-track subjects with cleared prerequisites', async () => {
      mockPrisma.scholarProspectus.findUnique.mockResolvedValue({
        prospectus_id: 1,
        scholar_profile_id: 10,
        subjects: [
          {
            subject_id: 101,
            subject_code: 'IT 101',
            descriptive_title: 'Intro to IT',
            units: 3.0,
            status: 'PASSED',
            prerequisites: [],
          },
          {
            subject_id: 102,
            subject_code: 'IT 102',
            descriptive_title: 'Prog 1',
            units: 3.0,
            status: 'PASSED',
            prerequisites: ['IT 101'],
          },
          {
            subject_id: 103,
            subject_code: 'IT 201',
            descriptive_title: 'Data Structures',
            units: 3.0,
            status: 'UNTAKEN',
            prerequisites: ['IT 102'],
          },
        ],
      });

      const audit = await auditEngine.runAudit(10, [
        enrolled('IT 201', 15, 'Data Structures'),
      ]);

      expect(audit.all_cleared).toBe(true);
      expect(audit.flags).toEqual([]);
      expect(audit.subjects_audit[0].status).toBe('ON_TRACK');
      expect(audit.subjects_audit[0].curriculum_subject_id).toBe(103);
      expect(audit.subjects_audit[0].remarks).toBe(
        'Curriculum verified and all prerequisites cleared.',
      );
    });

    it('flags MISSING_PREREQUISITE when a prerequisite is ungraded and untaken', async () => {
      mockPrisma.scholarProspectus.findUnique.mockResolvedValue({
        prospectus_id: 1,
        scholar_profile_id: 10,
        subjects: [
          {
            subject_id: 101,
            subject_code: 'IT 101',
            descriptive_title: 'Intro to IT',
            units: 3.0,
            status: 'UNTAKEN',
            prerequisites: [],
          },
          {
            subject_id: 102,
            subject_code: 'IT 102',
            descriptive_title: 'Prog 1',
            units: 3.0,
            status: 'UNTAKEN',
            prerequisites: ['IT 101'],
          },
        ],
      });

      const audit = await auditEngine.runAudit(10, [
        enrolled('IT 102', 3, 'Prog 1'),
      ]);

      expect(audit.all_cleared).toBe(false);
      expect(audit.flags).toContain('MISSING_PREREQUISITE:IT 102');
      expect(audit.subjects_audit[0].status).toBe('MISSING_PREREQUISITE');
      expect(audit.subjects_audit[0].unmet_prerequisites).toEqual(['IT 101']);
      expect(audit.subjects_audit[0].remarks).toBe(
        'Prerequisite (IT 101) not cleared in prior terms.',
      );
    });

    it('does not flag MISSING_PREREQUISITE for NONE, N/A, or standing requirements', async () => {
      mockPrisma.scholarProspectus.findUnique.mockResolvedValue({
        prospectus_id: 1,
        scholar_profile_id: 10,
        subjects: [
          {
            subject_id: 201,
            subject_code: 'GE 101',
            descriptive_title: 'Understanding Self',
            units: 3.0,
            status: 'UNTAKEN',
            prerequisites: ['None'],
          },
          {
            subject_id: 202,
            subject_code: 'IT 401',
            descriptive_title: 'Capstone 1',
            units: 3.0,
            status: 'UNTAKEN',
            prerequisites: ['4th Year Standing', 'N/A'],
          },
        ],
      });

      const audit = await auditEngine.runAudit(10, [
        enrolled('GE 101', 6, 'Understanding Self'),
        enrolled('IT 401', 6, 'Capstone 1'),
      ]);

      expect(audit.all_cleared).toBe(true);
      expect(audit.flags).toEqual([]);
      expect(audit.subjects_audit[0].status).toBe('ON_TRACK');
      expect(audit.subjects_audit[1].status).toBe('ON_TRACK');
    });

    it('recognizes every supported proof that a prerequisite was cleared', async () => {
      mockPrisma.scholarProspectus.findUnique.mockResolvedValue({
        prospectus_id: 1,
        scholar_profile_id: 10,
        subjects: [
          {
            subject_id: 1,
            subject_code: 'A 1',
            status: 'PASSED',
            prerequisites: [],
          },
          {
            subject_id: 2,
            subject_code: 'B 2',
            status: 'TAKEN',
            prerequisites: [],
          },
          {
            subject_id: 3,
            subject_code: 'C 3',
            status: 'COMPLETED',
            prerequisites: [],
          },
          {
            subject_id: 4,
            subject_code: 'D 4',
            status: 'CREDIT',
            prerequisites: [],
          },
          {
            subject_id: 5,
            subject_code: 'E 5',
            status: 'ENROLLED',
            prerequisites: [],
          },
          {
            subject_id: 6,
            subject_code: 'F 6',
            status: 'UNTAKEN',
            grade: 2.0,
            prerequisites: [],
          },
          {
            subject_id: 7,
            subject_code: 'G 7',
            status: 'UNTAKEN',
            credited_term: '2025-1',
            prerequisites: [],
          },
          {
            subject_id: 8,
            subject_code: 'H 8',
            status: 'UNTAKEN',
            historical_document_id: 12,
            prerequisites: [],
          },
          {
            subject_id: 9,
            subject_code: 'I 9',
            status: 'UNTAKEN',
            remarks: 'Credited as an equivalent course',
            prerequisites: [],
          },
          {
            subject_id: 10,
            subject_code: 'J 10',
            status: 'UNTAKEN',
            grade: 5.0,
            prerequisites: [],
          },
          {
            subject_id: 11,
            subject_code: 'K 11',
            status: 'UNTAKEN',
            grade: 0,
            prerequisites: [],
          },
          {
            subject_id: 12,
            subject_code: 'TARGET 1',
            status: 'UNTAKEN',
            prerequisites: [
              'A 1',
              'B 2',
              'C 3',
              'D 4',
              'E 5',
              'F 6',
              'G 7',
              'H 8',
              'I 9',
              'J 10',
              'K 11',
            ],
          },
        ],
      });

      const audit = await auditEngine.runAudit(10, [
        enrolled('TARGET 1', 15, 'Target'),
      ]);

      expect(audit.subjects_audit[0].status).toBe('MISSING_PREREQUISITE');
      expect(audit.subjects_audit[0].unmet_prerequisites).toEqual([
        'J 10',
        'K 11',
      ]);
    });

    it('clears a prerequisite when the prior subject is CREDITED or has a passing grade', async () => {
      mockPrisma.scholarProspectus.findUnique.mockResolvedValue({
        prospectus_id: 1,
        scholar_profile_id: 10,
        subjects: [
          {
            subject_id: 101,
            subject_code: 'MATH 101',
            descriptive_title: 'Calculus 1',
            units: 3.0,
            status: 'CREDITED',
            grade: 1.5,
            prerequisites: [],
          },
          {
            subject_id: 102,
            subject_code: 'MATH 102',
            descriptive_title: 'Calculus 2',
            units: 3.0,
            status: 'UNTAKEN',
            prerequisites: ['MATH 101'],
          },
        ],
      });

      const audit = await auditEngine.runAudit(10, [
        enrolled('MATH 102', 15, 'Calculus 2'),
      ]);

      expect(audit.all_cleared).toBe(true);
      expect(audit.flags).toEqual([]);
      expect(audit.subjects_audit[0].status).toBe('ON_TRACK');
    });

    it('clears prerequisites with /L lab notation when the base lecture is credited', async () => {
      mockPrisma.scholarProspectus.findUnique.mockResolvedValue({
        prospectus_id: 1,
        scholar_profile_id: 10,
        subjects: [
          {
            subject_id: 101,
            subject_code: 'PHYS 101',
            descriptive_title: 'Physics 1',
            units: 3.0,
            status: 'CREDITED',
            grade: 3.5,
            prerequisites: [],
          },
          {
            subject_id: 102,
            subject_code: 'IT 11',
            descriptive_title: 'Networking 2',
            units: 3.0,
            status: 'CREDITED',
            grade: 4.0,
            prerequisites: [],
          },
          {
            subject_id: 103,
            subject_code: 'PHYS 102',
            descriptive_title: 'Physics 2',
            units: 4.0,
            status: 'UNTAKEN',
            prerequisites: ['PHYS 101/L'],
          },
          {
            subject_id: 104,
            subject_code: 'IT 15',
            descriptive_title: 'Integrative Prog',
            units: 3.0,
            status: 'UNTAKEN',
            prerequisites: ['IT 11/L'],
          },
        ],
      });

      const audit = await auditEngine.runAudit(10, [
        enrolled('PHYS 102', 8, 'Physics 2'),
        enrolled('IT 15', 7, 'Integrative Prog'),
      ]);

      expect(audit.all_cleared).toBe(true);
      expect(audit.flags).toEqual([]);
      expect(audit.subjects_audit[0].status).toBe('ON_TRACK');
      expect(audit.subjects_audit[1].status).toBe('ON_TRACK');
    });

    it('matches a plain enrolled code against a lab-suffixed curriculum entry', async () => {
      mockPrisma.scholarProspectus.findUnique.mockResolvedValue({
        prospectus_id: 1,
        scholar_profile_id: 10,
        subjects: [
          {
            subject_id: 101,
            subject_code: 'IT 101 LAB',
            descriptive_title: 'IT Lab',
            status: 'UNTAKEN',
            prerequisites: [],
          },
        ],
      });

      const audit = await auditEngine.runAudit(10, [
        enrolled('IT 101', 15, 'Intro'),
      ]);

      expect(audit.subjects_audit[0].status).toBe('ON_TRACK');
      expect(audit.subjects_audit[0].curriculum_subject_id).toBe(101);
      expect(audit.subjects_audit[0].descriptive_title).toBe('IT Lab');
    });

    it('matches a lab-suffixed enrolled code against the base curriculum entry', async () => {
      mockPrisma.scholarProspectus.findUnique.mockResolvedValue({
        prospectus_id: 1,
        scholar_profile_id: 10,
        subjects: [
          {
            subject_id: 101,
            subject_code: 'IT 101',
            descriptive_title: 'Intro',
            status: 'UNTAKEN',
            prerequisites: [],
          },
        ],
      });

      const audit = await auditEngine.runAudit(10, [
        enrolled('IT 101 LAB', 15, 'Lab'),
      ]);

      expect(audit.subjects_audit[0].status).toBe('ON_TRACK');
      expect(audit.subjects_audit[0].curriculum_subject_id).toBe(101);
    });

    it('flags underload only when the credit load is positive and below 12 units', async () => {
      mockPrisma.scholarProspectus.findUnique.mockResolvedValue({
        prospectus_id: 1,
        scholar_profile_id: 10,
        subjects: [
          {
            subject_id: 1,
            subject_code: 'IT 101',
            descriptive_title: 'Intro',
            status: 'UNTAKEN',
            prerequisites: [],
          },
        ],
      });

      const under = await auditEngine.runAudit(10, [enrolled('IT 101', 11)]);
      const exact = await auditEngine.runAudit(10, [enrolled('IT 101', 12)]);

      expect(under.flags).toContain('UNDERLOAD_UNITS');
      expect(under.underload_flag).toBe(true);
      expect(under.all_cleared).toBe(true);
      expect(exact.flags).not.toContain('UNDERLOAD_UNITS');
      expect(exact.underload_flag).toBe(false);
    });

    it('never flags overload and defaults invalid units to three', async () => {
      mockPrisma.scholarProspectus.findUnique.mockResolvedValue({
        prospectus_id: 1,
        scholar_profile_id: 10,
        subjects: [
          {
            subject_id: 1,
            subject_code: 'IT 101',
            descriptive_title: 'Intro',
            status: 'UNTAKEN',
            prerequisites: [],
          },
        ],
      });

      const audit = await auditEngine.runAudit(10, [
        enrolled('IT 101', Number.NaN),
      ]);

      expect(audit.total_units).toBe(3);
      expect(audit.overload_flag).toBe(false);
    });

    it('omits cross-document reconciliation when no document identity is supplied', async () => {
      mockPrisma.scholarProspectus.findUnique.mockResolvedValue(null);

      const audit = await auditEngine.runAudit(10, [enrolled('IT 101', 15)], {
        academicYear: '2026-2027',
        semester: '1st Semester',
      });

      expect(mockPrisma.scholarProfile.findUnique).not.toHaveBeenCalled();
      expect(audit.cross_doc_reconciliation).toBeUndefined();
    });

    it('scores fully matching COR, SOA, and profile identities at 100', async () => {
      mockPrisma.scholarProspectus.findUnique.mockResolvedValue(null);
      mockPrisma.scholarProfile.findUnique.mockResolvedValue({
        student_number: '2020-001',
        first_name: 'Ana',
        last_name: 'Cruz',
      });

      const audit = await auditEngine.runAudit(10, [], {
        corStudentId: '2020-001',
        corStudentName: 'Ana Cruz',
        soaStudentId: '2020-001',
        soaStudentName: 'Ana Cruz Dela Vega',
      });

      expect(audit.cross_doc_reconciliation).toEqual({
        is_match: true,
        student_id_match: true,
        student_name_match: true,
        confidence_score: 100,
        mismatches: [],
      });
      expect(audit.flags).toEqual([]);
      expect(audit.all_cleared).toBe(true);
    });

    it('flags a COR/SOA student id mismatch and deducts 40 points', async () => {
      mockPrisma.scholarProspectus.findUnique.mockResolvedValue(null);
      mockPrisma.scholarProfile.findUnique.mockResolvedValue({
        student_number: '2020-001',
        first_name: 'Ana',
        last_name: 'Cruz',
      });

      const audit = await auditEngine.runAudit(10, [], {
        corStudentId: '2020-001',
        corStudentName: 'Ana Cruz',
        soaStudentId: '2020-002',
        soaStudentName: 'Ana Cruz',
      });

      expect(audit.cross_doc_reconciliation).toEqual({
        is_match: false,
        student_id_match: false,
        student_name_match: true,
        confidence_score: 60,
        mismatches: ['COR and SOA Student ID mismatch'],
      });
      expect(audit.flags).toContain(
        'RECONCILIATION_FLAG:COR and SOA Student ID mismatch',
      );
      expect(audit.all_cleared).toBe(false);
    });

    it('flags a document id that does not match the scholar profile and deducts 30 points', async () => {
      mockPrisma.scholarProspectus.findUnique.mockResolvedValue(null);
      mockPrisma.scholarProfile.findUnique.mockResolvedValue({
        student_number: '2020-001',
        first_name: 'Ana',
        last_name: 'Cruz',
      });

      const audit = await auditEngine.runAudit(10, [], {
        corStudentId: '9999-999',
        corStudentName: 'Ana Cruz',
      });

      expect(audit.cross_doc_reconciliation).toEqual({
        is_match: false,
        student_id_match: false,
        student_name_match: true,
        confidence_score: 70,
        mismatches: [
          'Document Student ID does not match Profile Student Number',
        ],
      });
    });

    it('flags a COR/SOA name mismatch and deducts 30 points', async () => {
      mockPrisma.scholarProspectus.findUnique.mockResolvedValue(null);
      mockPrisma.scholarProfile.findUnique.mockResolvedValue({
        student_number: '2020-001',
        first_name: 'Ana',
        last_name: 'Cruz',
      });

      const audit = await auditEngine.runAudit(10, [], {
        corStudentId: '2020-001',
        corStudentName: 'Ana Cruz',
        soaStudentId: '2020-001',
        soaStudentName: 'Ben Tan',
      });

      expect(audit.cross_doc_reconciliation).toEqual(
        expect.objectContaining({
          is_match: false,
          student_id_match: true,
          student_name_match: false,
          confidence_score: 70,
          mismatches: ['COR and SOA Student Name mismatch'],
        }),
      );
    });

    it('accumulates id and name mismatches into a lower confidence score', async () => {
      mockPrisma.scholarProspectus.findUnique.mockResolvedValue(null);
      mockPrisma.scholarProfile.findUnique.mockResolvedValue({
        student_number: '2020-001',
        first_name: 'Ana',
        last_name: 'Cruz',
      });

      const audit = await auditEngine.runAudit(10, [], {
        corStudentId: '9999-999',
        corStudentName: 'Ben Tan',
        soaStudentId: '9999-999',
        soaStudentName: 'Someone Else',
      });

      expect(audit.cross_doc_reconciliation).toEqual({
        is_match: false,
        student_id_match: false,
        student_name_match: false,
        confidence_score: 40,
        mismatches: [
          'Document Student ID does not match Profile Student Number',
          'COR and SOA Student Name mismatch',
        ],
      });
      expect(audit.flags).toEqual([
        'RECONCILIATION_FLAG:Document Student ID does not match Profile Student Number',
        'RECONCILIATION_FLAG:COR and SOA Student Name mismatch',
      ]);
    });

    it('tolerates a missing scholar profile when the documents agree with each other', async () => {
      mockPrisma.scholarProspectus.findUnique.mockResolvedValue(null);
      mockPrisma.scholarProfile.findUnique.mockResolvedValue(null);

      const audit = await auditEngine.runAudit(10, [], {
        corStudentId: '2020-001',
        corStudentName: 'Ana Cruz',
        soaStudentId: '2020-001',
        soaStudentName: 'Ana Cruz',
      });

      expect(audit.cross_doc_reconciliation).toEqual({
        is_match: true,
        student_id_match: true,
        student_name_match: true,
        confidence_score: 100,
        mismatches: [],
      });
    });
  });
});
