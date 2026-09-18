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

    it('should not flag MISSING_PREREQUISITE when prerequisite is NONE, N/A, or standing requirement', async () => {
      mockPrisma.scholarProspectus.findUnique.mockResolvedValue({
        prospectus_id: 1,
        scholar_profile_id: 10,
        subjects: [
          { subject_id: 201, subject_code: 'GE 101', descriptive_title: 'Understanding Self', units: 3.0, status: 'UNTAKEN', prerequisites: ['None'] },
          { subject_id: 202, subject_code: 'IT 401', descriptive_title: 'Capstone 1', units: 3.0, status: 'UNTAKEN', prerequisites: ['4th Year Standing', 'N/A'] },
        ],
      });

      const audit = await auditEngine.runAudit(10, [
        { subject_code: 'GE 101', descriptive_title: 'Understanding Self', units: 6.0 },
        { subject_code: 'IT 401', descriptive_title: 'Capstone 1', units: 6.0 },
      ]);

      expect(audit.all_cleared).toBe(true);
      expect(audit.flags).toEqual([]);
      expect(audit.subjects_audit[0].status).toBe('ON_TRACK');
      expect(audit.subjects_audit[1].status).toBe('ON_TRACK');
    });

    it('should clear prerequisite when prior subject is CREDITED or has passing grade', async () => {
      mockPrisma.scholarProspectus.findUnique.mockResolvedValue({
        prospectus_id: 1,
        scholar_profile_id: 10,
        subjects: [
          { subject_id: 101, subject_code: 'MATH 101', descriptive_title: 'Calculus 1', units: 3.0, status: 'CREDITED', grade: 1.5, prerequisites: [] },
          { subject_id: 102, subject_code: 'MATH 102', descriptive_title: 'Calculus 2', units: 3.0, status: 'UNTAKEN', prerequisites: ['MATH 101'] },
        ],
      });

      const audit = await auditEngine.runAudit(10, [
        { subject_code: 'MATH 102', descriptive_title: 'Calculus 2', units: 15.0 },
      ]);

      expect(audit.all_cleared).toBe(true);
      expect(audit.flags).toEqual([]);
      expect(audit.subjects_audit[0].status).toBe('ON_TRACK');
    });

    it('should clear prerequisites with /L lab notation when base lecture is passed/credited', async () => {
      mockPrisma.scholarProspectus.findUnique.mockResolvedValue({
        prospectus_id: 1,
        scholar_profile_id: 10,
        subjects: [
          { subject_id: 101, subject_code: 'PHYS 101', descriptive_title: 'Physics 1', units: 3.0, status: 'CREDITED', grade: 3.5, prerequisites: [] },
          { subject_id: 102, subject_code: 'IT 11', descriptive_title: 'Networking 2', units: 3.0, status: 'CREDITED', grade: 4.0, prerequisites: [] },
          { subject_id: 103, subject_code: 'PHYS 102', descriptive_title: 'Physics 2', units: 4.0, status: 'UNTAKEN', prerequisites: ['PHYS 101/L'] },
          { subject_id: 104, subject_code: 'IT 15', descriptive_title: 'Integrative Prog', units: 3.0, status: 'UNTAKEN', prerequisites: ['IT 11/L'] },
        ],
      });

      const audit = await auditEngine.runAudit(10, [
        { subject_code: 'PHYS 102', descriptive_title: 'Physics 2', units: 8.0 },
        { subject_code: 'IT 15', descriptive_title: 'Integrative Prog', units: 7.0 },
      ]);

      expect(audit.all_cleared).toBe(true);
      expect(audit.flags).toEqual([]);
      expect(audit.subjects_audit[0].status).toBe('ON_TRACK');
      expect(audit.subjects_audit[1].status).toBe('ON_TRACK');
    });
  });
});
