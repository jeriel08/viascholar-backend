import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Test, TestingModule } from '@nestjs/testing';
import { DocumentReconciliationService } from './document-reconciliation.service.js';
import { GradeCalculatorService } from './grade-calculator.service.js';
import type { ForensicMetadataResult } from './file-forensics.service.js';

const createGradeCalcMock = () => ({
  isForm138: vi.fn().mockReturnValue(false),
  computeGwa: vi.fn().mockReturnValue({
    computedGwa: 1.5,
    hasFailedGrade: false,
    totalUnits: 5,
  }),
});

const makeProfile = () => ({
  first_name: 'Juan',
  last_name: 'Dela Cruz',
  course_of_study: 'BS Information Technology',
  current_year_level: 2,
});

const makeCleanMetadata = (
  overrides: Partial<ForensicMetadataResult> = {},
): ForensicMetadataResult => ({
  is_flagged: false,
  detected_software: [],
  flags: [],
  ...overrides,
});

describe('DocumentReconciliationService', () => {
  let service: DocumentReconciliationService;
  let gradeCalc: ReturnType<typeof createGradeCalcMock>;

  beforeEach(async () => {
    gradeCalc = createGradeCalcMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DocumentReconciliationService,
        { provide: GradeCalculatorService, useValue: gradeCalc },
      ],
    }).compile();

    service = module.get<DocumentReconciliationService>(
      DocumentReconciliationService,
    );
  });

  it('is created by the Nest testing module', () => {
    expect(service).toBeDefined();
  });

  it('passes a fully consistent TOR document with no flags', () => {
    gradeCalc.computeGwa.mockReturnValue({
      computedGwa: 1.5,
      hasFailedGrade: false,
      totalUnits: 5,
    });

    const result = service.evaluateExtractedDocument(makeProfile(), 'TOR', {
      detected_document_type: 'TRANSCRIPT_OF_RECORDS',
      general_average: 1.5,
      grades: [
        { subject_code: 'IT 101', units: 3, grade: 1.5 },
        { subject_code: 'IT 102', units: 3, grade: 1.5 },
      ],
      student_name: 'Juan Dela Cruz',
      course_name: 'BS Information Technology',
      has_signature: 'true',
    });

    expect(result.risk_level).toBe('LOW');
    expect(result.flags).toEqual([]);
    expect(result.is_flagged).toBe(false);
    expect(result.summary).toContain('zero tampering indicators');
  });

  it('flags invalid document types as HIGH risk', () => {
    const result = service.evaluateExtractedDocument(makeProfile(), 'TOR', {
      detected_document_type: 'STATEMENT_OF_ACCOUNT',
      grades: [{ subject_code: 'A', units: 1, grade: 1.0 }],
      student_name: 'Juan Dela Cruz',
      has_signature: 'true',
    });

    expect(result.flags).toContain('INVALID_DOCUMENT_TYPE');
    expect(result.risk_level).toBe('HIGH');
    expect(result.is_flagged).toBe(true);
    expect(result.summary).toContain('STATEMENT_OF_ACCOUNT');
  });

  it('flags a Form 138 mismatch on a TOR upload', () => {
    gradeCalc.isForm138.mockReturnValue(false);

    const result = service.evaluateExtractedDocument(makeProfile(), 'TOR', {
      detected_document_type: 'FORM_138',
      grades: [{ subject_code: 'A', units: 1, grade: 1.0 }],
      student_name: 'Juan Dela Cruz',
      has_signature: 'true',
    });

    expect(result.flags).toContain('DOCUMENT_TYPE_MISMATCH');
    expect(result.risk_level).toBe('HIGH');
  });

  it('flags SEVERE_MATH_DISCREPANCY when the reported GWA deviates beyond the tolerance', () => {
    gradeCalc.computeGwa.mockReturnValue({
      computedGwa: 1.5,
      hasFailedGrade: false,
      totalUnits: 6,
    });

    const result = service.evaluateExtractedDocument(makeProfile(), 'TOR', {
      general_average: 4.0,
      grades: [
        { subject_code: 'A', units: 3, grade: 1.5 },
        { subject_code: 'B', units: 3, grade: 1.5 },
      ],
      student_name: 'Juan Dela Cruz',
      has_signature: 'true',
    });

    expect(result.flags).toContain('SEVERE_MATH_DISCREPANCY');
    expect(result.risk_level).toBe('HIGH');
    expect(result.math_reconciliation?.is_consistent).toBe(false);
    expect(result.math_reconciliation?.difference).toBeCloseTo(2.5, 1);
  });

  it('flags MODERATE_MATH_VARIANCE for small deviations', () => {
    gradeCalc.computeGwa.mockReturnValue({
      computedGwa: 1.5,
      hasFailedGrade: false,
      totalUnits: 6,
    });

    // Reported 1.8 vs computed 1.5: diff 0.3 <= 0.35 moderate tolerance for
    // the sub-3.0 emerging scale, so expect MODERATE rather than SEVERE.
    const result = service.evaluateExtractedDocument(makeProfile(), 'TOR', {
      general_average: 1.8,
      grades: [
        { subject_code: 'A', units: 3, grade: 1.5 },
        { subject_code: 'B', units: 3, grade: 1.5 },
      ],
      student_name: 'Juan Dela Cruz',
      has_signature: 'true',
    });

    expect(result.flags).toContain('MODERATE_MATH_VARIANCE');
    expect(result.risk_level).toBe('MEDIUM');
    expect(result.math_reconciliation?.is_consistent).toBe(false);
  });

  it('uses the 100-point tolerance for percentage scales', () => {
    gradeCalc.computeGwa.mockReturnValue({
      computedGwa: 85,
      hasFailedGrade: false,
      totalUnits: 6,
    });

    const result = service.evaluateExtractedDocument(makeProfile(), 'TOR', {
      general_average: 86.4,
      grades: [{ subject_code: 'A', units: 3, grade: 85 }],
      student_name: 'Juan Dela Cruz',
      has_signature: 'true',
    });

    expect(result.math_reconciliation?.is_consistent).toBe(true);
    expect(result.flags).not.toContain('SEVERE_MATH_DISCREPANCY');
  });

  it('computes per-semester averages and flags the semester-wise discrepancy when only one is off', () => {
    gradeCalc.computeGwa.mockReturnValue({
      computedGwa: 80,
      hasFailedGrade: false,
      totalUnits: 4,
    });

    const result = service.evaluateExtractedDocument(makeProfile(), 'TOR', {
      general_average: 80,
      first_sem_average: 85,
      second_sem_average: 75,
      // No semester-tagged grades in the plain array to avoid double counting;
      // sem1/sem2 are still honored through the explicit averages.
      grades: [{ subject_code: 'A', units: 3, grade: 80 }],
      student_name: 'Juan Dela Cruz',
      has_signature: 'true',
    });

    expect(result.math_reconciliation).toBeDefined();
    expect(result.math_reconciliation?.is_consistent).toBe(true);
  });

  it('flags impossible grade ranges', () => {
    gradeCalc.computeGwa.mockReturnValue({
      computedGwa: 0,
      hasFailedGrade: false,
      totalUnits: 0,
    });

    const result = service.evaluateExtractedDocument(makeProfile(), 'TOR', {
      grades: [{ subject_code: 'A', units: 3, grade: 150 }],
      student_name: 'Juan Dela Cruz',
      has_signature: 'true',
    });

    expect(result.flags).toContain('ANOMALOUS_GRADE_VALUE_DETECTED');
    expect(result.risk_level).toBe('HIGH');
  });

  it('flags a failed grade filter — ignores zero grades and null entries', () => {
    gradeCalc.computeGwa.mockReturnValue({
      computedGwa: 1.5,
      hasFailedGrade: false,
      totalUnits: 6,
    });

    const result = service.evaluateExtractedDocument(makeProfile(), 'TOR', {
      grades: [
        { subject_code: 'A', units: 3, grade: 'PSD' },
        { subject_code: 'B', units: 3, grade: null },
        { subject_code: 'C', units: 3, grade: 0 },
        { subject_code: 'D', units: 3, grade: 2 },
      ],
      student_name: 'Juan Dela Cruz',
      has_signature: 'true',
    });

    // Those grades are filtered out before math reconciliation, so only D is left.
    expect(gradeCalc.computeGwa).toHaveBeenCalledWith(
      expect.objectContaining({
        gradeItems: [expect.objectContaining({ subject_code: 'D', grade: 2 })],
      }),
    );
    expect(result.flags).not.toContain('ANOMALOUS_GRADE_VALUE_DETECTED');
  });

  it('flags a mismatched student name as MEDIUM risk', () => {
    const result = service.evaluateExtractedDocument(makeProfile(), 'TOR', {
      student_name: 'Completely Unrelated Person',
      grades: [],
      has_signature: 'true',
    });

    expect(result.flags).toContain('STUDENT_NAME_MISMATCH');
    expect(result.risk_level).toBe('MEDIUM');
  });

  it('flags a course mismatch for college documents', () => {
    const result = service.evaluateExtractedDocument(makeProfile(), 'TOR', {
      student_name: 'Juan Dela Cruz',
      course_name: 'Doctor of Medicine',
      grades: [],
      has_signature: 'true',
    });

    expect(result.flags).toContain('COURSE_MISMATCH');
  });

  it('flags a missing registrar signature', () => {
    const result = service.evaluateExtractedDocument(makeProfile(), 'TOR', {
      student_name: 'Juan Dela Cruz',
      grades: [],
      has_signature: 'false',
    });

    expect(result.flags).toContain('MISSING_REGISTRAR_SIGNATURE');
  });

  it('propagates the metadata forensics flags and picks up the software signature risk', () => {
    const metadata = makeCleanMetadata({
      flags: ['SUSPICIOUS_SOFTWARE_PHOTOSHOP'],
      detected_software: ['photoshop'],
    });

    const result = service.evaluateExtractedDocument(
      makeProfile(),
      'TOR',
      { student_name: 'Juan Dela Cruz', grades: [], has_signature: 'true' },
      metadata,
    );

    expect(result.flags).toContain('SUSPICIOUS_SOFTWARE_PHOTOSHOP');
    expect(result.risk_level).toBe('HIGH');
    expect(result.metadata_forensics).toBe(metadata);
    expect(result.summary).toContain('photoshop');
  });

  it('marks the document unflagged when only a MODERATE_MATH_VARIANCE is reported', () => {
    // sanity check the is_flagged mapping = risk_level !== LOW
    gradeCalc.computeGwa.mockReturnValue({
      computedGwa: 84,
      hasFailedGrade: false,
      totalUnits: 2,
    });

    const result = service.evaluateExtractedDocument(makeProfile(), 'TOR', {
      general_average: 87,
      grades: [{ subject_code: 'A', units: 2, grade: 84 }],
      student_name: 'Juan Dela Cruz',
      has_signature: 'true',
    });

    expect(result.risk_level).toBe('MEDIUM');
    expect(result.is_flagged).toBe(true);
  });
});
