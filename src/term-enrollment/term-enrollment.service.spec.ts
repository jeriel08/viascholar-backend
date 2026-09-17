import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { EnrollmentAuditEngineService } from './services/enrollment-audit-engine.service.js';
import { EnrollmentOcrService } from './services/enrollment-ocr.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { LlamaExtractService } from '../documents/extractors/llama-extract.service.js';

describe('TermEnrollment Services', () => {
  let ocrService: EnrollmentOcrService;
  let auditEngine: EnrollmentAuditEngineService;
  let prisma: PrismaService;

  const mockPrisma = {
    scholarProspectus: {
      findUnique: jest.fn<any>(),
    },
    scholarProfile: {
      findUnique: jest.fn<any>(),
    },
    termEnrollment: {
      findFirst: jest.fn<any>(),
      upsert: jest.fn<any>(),
    },
  };

  const mockLlamaExtract = {
    extractEnrollmentCorData: jest.fn(),
    extractEnrollmentSoaData: jest.fn(),
    extractConsolidatedEnrollmentData: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EnrollmentOcrService,
        EnrollmentAuditEngineService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: LlamaExtractService, useValue: mockLlamaExtract },
      ],
    }).compile();

    ocrService = module.get<EnrollmentOcrService>(EnrollmentOcrService);
    auditEngine = module.get<EnrollmentAuditEngineService>(EnrollmentAuditEngineService);
    prisma = module.get<PrismaService>(PrismaService);
  });

  describe('EnrollmentOcrService Normalization', () => {
    it('should normalize subject codes cleanly', () => {
      expect(ocrService.normalizeSubjectCode('IT - 101 A')).toBe('IT101A');
      expect(ocrService.normalizeSubjectCode('cce 102')).toBe('CCE102');
      expect(ocrService.normalizeSubjectCode('MATH II')).toBe('MATH2');
    });

    it('should normalize semester names', () => {
      expect(ocrService.normalizeSemester('1st Sem')).toBe('1st Semester');
      expect(ocrService.normalizeSemester('2nd Semester 2026')).toBe('2nd Semester');
      expect(ocrService.normalizeSemester('Summer Term')).toBe('Summer');
    });

    it('should normalize year levels', () => {
      expect(ocrService.normalizeYearLevel('3rd Year')).toBe(3);
      expect(ocrService.normalizeYearLevel('1st Year')).toBe(1);
      expect(ocrService.normalizeYearLevel(4)).toBe(4);
    });
  });

  describe('EnrollmentAuditEngineService', () => {
    it('should approve on-track subjects with cleared prerequisites', async () => {
      mockPrisma.scholarProspectus.findUnique.mockResolvedValue({
        prospectus_id: 1,
        scholar_profile_id: 10,
        subjects: [
          { subject_id: 101, subject_code: 'IT 101', descriptive_title: 'Intro to IT', units: 3.0, status: 'PASSED', prerequisites: [] },
          { subject_id: 102, subject_code: 'IT 102', descriptive_title: 'Prog 1', units: 3.0, status: 'PASSED', prerequisites: ['IT 101'] },
          { subject_id: 103, subject_code: 'IT 201', descriptive_title: 'Data Structures', units: 3.0, status: 'UNTAKEN', prerequisites: ['IT 102'] },
        ],
      });

      const audit = await auditEngine.runAudit(10, [
        { subject_code: 'IT 201', descriptive_title: 'Data Structures', units: 15.0 },
      ]);

      expect(audit.all_cleared).toBe(true);
      expect(audit.flags).toEqual([]);
      expect(audit.subjects_audit[0].status).toBe('ON_TRACK');
    });

    it('should flag MISSING_PREREQUISITE when prerequisite is untaken', async () => {
      mockPrisma.scholarProspectus.findUnique.mockResolvedValue({
        prospectus_id: 1,
        scholar_profile_id: 10,
        subjects: [
          { subject_id: 101, subject_code: 'IT 101', descriptive_title: 'Intro to IT', units: 3.0, status: 'UNTAKEN', prerequisites: [] },
          { subject_id: 102, subject_code: 'IT 102', descriptive_title: 'Prog 1', units: 3.0, status: 'UNTAKEN', prerequisites: ['IT 101'] },
        ],
      });

      const audit = await auditEngine.runAudit(10, [
        { subject_code: 'IT 102', descriptive_title: 'Prog 1', units: 3.0 },
      ]);

      expect(audit.all_cleared).toBe(false);
      expect(audit.flags).toContain('MISSING_PREREQUISITE:IT 102');
      expect(audit.subjects_audit[0].status).toBe('MISSING_PREREQUISITE');
    });

    it('should flag OFF_TRACK_SUBJECT when subject is not in curriculum', async () => {
      mockPrisma.scholarProspectus.findUnique.mockResolvedValue({
        prospectus_id: 1,
        scholar_profile_id: 10,
        subjects: [
          { subject_id: 101, subject_code: 'IT 101', descriptive_title: 'Intro to IT', units: 3.0, status: 'PASSED', prerequisites: [] },
        ],
      });

      const audit = await auditEngine.runAudit(10, [
        { subject_code: 'PE 999', descriptive_title: 'Random Course', units: 2.0 },
      ]);

      expect(audit.all_cleared).toBe(false);
      expect(audit.flags).toContain('OFF_TRACK_SUBJECT:PE 999');
      expect(audit.subjects_audit[0].status).toBe('OFF_TRACK');
    });
  });
});
